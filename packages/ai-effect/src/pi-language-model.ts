// Bridge "Pi serves Effect": an effect/ai `LanguageModel` whose requests go to a pi-ai chat model from `Models`.

import type {
	Api,
	ImageContent,
	JsonObject,
	Message,
	Model,
	ModelsSimpleStreamOptions,
	AssistantMessage as PiAssistantMessage,
	Context as PiContext,
	Tool as PiTool,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	Array as Arr,
	Cache,
	Clock,
	DateTime,
	Effect,
	Formatter,
	Layer,
	Match,
	Option,
	Predicate,
	pipe,
	String as Str,
	Stream,
} from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { Base64 } from "effect/encoding";
import type { ModelNotFound, ModelRequestError } from "./errors.ts";
import { getModel, type ModelRef } from "./model-ref.ts";
import { Models } from "./models.ts";
import { completeSimple, type ResponseEvent, streamSimple } from "./request.ts";
import type { StrictOmit } from "./strict-omit.ts";
import { emptyUsage } from "./usage.ts";

/**
 * pi-ai's provider-neutral request options, sent with every request of the model (`reasoning`, `maxTokens`,
 * `temperature`, `sessionId`, ...). Without `signal` (the fiber owns cancellation), `toolChoice` (each effect/ai
 * request sets it) and `deferred` (a deferred response has no content to return).
 */
export type Options = StrictOmit<ModelsSimpleStreamOptions, "signal" | "toolChoice" | "deferred">;

/**
 * An effect/ai `LanguageModel` backed by the pi-ai chat model `ref` names, looked up once, when this runs.
 *
 * Carried: system, user, assistant and tool messages, images, the tools of the request with their JSON Schema, text,
 * reasoning, tool calls, finish reason and token usage. Not carried, because pi-ai has no place for them: structured
 * output (`generateObject`) and a tool choice that forces a call fail with an `InvalidRequestError`; files that are
 * not inline images fail the same way; provider-executed tools are declared as ordinary tools; pi-ai's cost and its
 * replay signatures for reasoning stay on the pi side.
 */
export const make = Effect.fn("PiLanguageModel.make")(function* (
	ref: ModelRef,
	options?: Options,
): Effect.fn.Return<LanguageModel.LanguageModel, ModelNotFound, Models> {
	const models = yield* Models;
	const model = yield* getModel(ref);
	// A tool's JSON Schema is compiled from its Schema; a toolkit's tools are the same objects from one request to the
	// next (effect/ai keeps them), so each is compiled once for this model.
	const tools = yield* Cache.make({
		capacity: TOOL_CAPACITY,
		lookup: (tool: Tool.Any) => Effect.sync(() => toPiTool(tool)),
	});
	return yield* LanguageModel.make({
		generateText: Effect.fn("PiLanguageModel.generateText")(
			function* (request: LanguageModel.ProviderOptions) {
				const { context, toolChoice } = yield* toPiRequest(request, model, tools, "generateText");
				const message = yield* completeSimple(model, context, { ...options, toolChoice }).pipe(
					Effect.mapError(toAiError("generateText")),
				);
				return [...Arr.map(message.content, contentPart), ...finalParts(message)];
			},
			Effect.provideService(Models, models),
		),
		streamText: (request) =>
			Stream.unwrap(
				Effect.map(toPiRequest(request, model, tools, "streamText"), ({ context, toolChoice }) =>
					streamSimple(model, context, { ...options, toolChoice }).pipe(
						Stream.mapError(toAiError("streamText")),
						Stream.map(eventParts),
						Stream.flattenIterable,
					),
				),
			).pipe(Stream.provideService(Models, models)),
		// pi-ai keeps later system messages in place for models that accept them and folds them into the first otherwise.
		supportsSystemMessagesInHistory: Effect.succeed(true),
	});
});

/** `make` as a Layer: fails with `ModelNotFound` when it is built and `Models` does not list the model. */
export function layer(
	ref: ModelRef,
	options?: Options,
): Layer.Layer<LanguageModel.LanguageModel, ModelNotFound, Models> {
	return Layer.effect(LanguageModel.LanguageModel, make(ref, options));
}

/** How many tools' declarations one model keeps compiled. */
const TOOL_CAPACITY = 256;

const MODULE = "PiLanguageModel";

interface PiRequest {
	readonly context: PiContext;
	readonly toolChoice: ToolChoice | undefined;
}

/** One effect/ai request as pi-ai's request input. Fails for what pi-ai cannot be asked. */
const toPiRequest = Effect.fn("PiLanguageModel.toPiRequest")(
	function* (
		request: LanguageModel.ProviderOptions,
		model: Model<Api>,
		tools: Cache.Cache<Tool.Any, PiTool>,
		_method: string,
	): Effect.fn.Return<PiRequest, AiError.InvalidRequestError> {
		if (request.responseFormat.type === "json") {
			return yield* notCarried("responseFormat", "pi-ai has no structured output option");
		}
		const toolChoice = yield* toToolChoice(request);
		const timestamp = yield* Clock.currentTimeMillis;
		const converted = yield* Effect.forEach(
			request.prompt.content,
			(message) => toPiMessages(message, model, timestamp),
			{ concurrency: 1 },
		);
		const piTools = yield* Effect.forEach(request.tools, (tool) => Cache.get(tools, tool), { concurrency: 1 });
		const messages = Arr.flatten(converted);
		const first = messages[0];
		// A system message before any other message is pi-ai's system prompt; a later one stays where it is.
		return first?.role === "system" && Predicate.isString(first.content)
			? { context: { systemPrompt: first.content, messages: Arr.drop(messages, 1), tools: piTools }, toolChoice }
			: { context: { systemPrompt: undefined, messages, tools: piTools }, toolChoice };
	},
	(effect, _request, _model, _tools, method) =>
		Effect.mapError(effect, (reason) => AiError.make({ module: MODULE, method, reason })),
);

function notCarried(parameter: string, description: string): AiError.InvalidRequestError {
	return AiError.InvalidRequestError.make({ parameter, description });
}

/** pi-ai's provider-neutral tool choice is `auto` or `none`; a request without tools leaves it to the provider. */
const toToolChoice = Effect.fnUntraced(function* (
	request: LanguageModel.ProviderOptions,
): Effect.fn.Return<ToolChoice | undefined, AiError.InvalidRequestError> {
	const choice = request.toolChoice;
	if (request.tools.length === 0) return undefined;
	if (choice === "auto" || choice === "none") return choice;
	// effect/ai's tool choice is an untagged union we do not own, so `in` is the only way to tell its object forms
	// apart. `oneOf` has already narrowed `request.tools`; only its mode is left to carry.
	if (typeof choice === "object" && "oneOf" in choice && choice.mode !== "required") return "auto";
	return yield* notCarried("toolChoice", "pi-ai's provider-neutral tool choice cannot force a tool call");
});

/** One effect/ai prompt message as pi-ai messages: a tool message holds one result per call. */
const toPiMessages = Effect.fnUntraced(function* (
	message: Prompt.Message,
	model: Model<Api>,
	timestamp: number,
): Effect.fn.Return<ReadonlyArray<Message>, AiError.InvalidRequestError> {
	return yield* Match.value(message).pipe(
		Match.discriminatorsExhaustive("role")({
			system: (system): Effect.Effect<ReadonlyArray<Message>> =>
				Effect.succeed([{ role: "system", content: system.content, timestamp }]),
			user: (user): Effect.Effect<ReadonlyArray<Message>, AiError.InvalidRequestError> =>
				Effect.map(Effect.forEach(user.content, toContent, { concurrency: 1 }), (content) => [
					{ role: "user", content, timestamp },
				]),
			assistant: (assistant): Effect.Effect<ReadonlyArray<Message>> =>
				Effect.succeed([toAssistantMessage(assistant, model, timestamp)]),
			tool: (tool): Effect.Effect<ReadonlyArray<Message>, AiError.InvalidRequestError> =>
				// An approval response has no pi-ai counterpart; effect/ai resolves it before the request.
				Effect.forEach(
					Arr.filter(tool.content, (part): part is Prompt.ToolResultPart => part.type === "tool-result"),
					(part) => toToolResult(part, timestamp),
					{ concurrency: 1 },
				),
		}),
	);
});

const toContent = Effect.fnUntraced(function* (
	part: Prompt.TextPart | Prompt.FilePart,
): Effect.fn.Return<TextContent | ImageContent, AiError.InvalidRequestError> {
	if (part.type === "text") return { type: "text", text: part.text };
	if (!pipe(part.mediaType, Str.startsWith("image/")) || part.data instanceof URL) {
		return yield* notCarried("prompt", `pi-ai takes inline images only, not a ${part.mediaType} file or a URL`);
	}
	return {
		type: "image",
		mimeType: part.mediaType,
		data: Predicate.isString(part.data) ? withoutDataUrlPrefix(part.data) : Base64.encode(part.data),
	};
});

/** effect/ai accepts base64 text with or without a `data:<type>;base64,` prefix; pi-ai wants the bare base64. */
function withoutDataUrlPrefix(data: string): string {
	if (!pipe(data, Str.startsWith("data:"))) return data;
	return pipe(
		data,
		Str.indexOf(","),
		Option.map((comma) => pipe(data, Str.slice(comma + 1))),
		Option.getOrElse(() => data),
	);
}

function toAssistantMessage(
	message: Prompt.AssistantMessage,
	model: Model<Api>,
	timestamp: number,
): PiAssistantMessage {
	const content = Arr.flatMap(message.content, assistantContent);
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: Arr.some(content, (block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

/**
 * The pi-ai content of one part of an assistant message. Files, provider-executed calls and their results, and
 * approval requests have no place in a pi-ai message.
 */
const assistantContent = Match.type<Prompt.AssistantMessagePart>().pipe(
	Match.discriminators("type")({
		text: (part): PiAssistantMessage["content"] => [{ type: "text", text: part.text }],
		reasoning: (part): PiAssistantMessage["content"] => [{ type: "thinking", thinking: part.text }],
		"tool-call": (part): PiAssistantMessage["content"] =>
			part.providerExecuted
				? []
				: // A decode boundary: a prompt's tool call params are the JSON object a model sent, typed `unknown`.
					[{ type: "toolCall", id: part.id, name: part.name, arguments: part.params as JsonObject }],
	}),
	Match.orElse((): PiAssistantMessage["content"] => []),
);

const toToolResult = Effect.fnUntraced(function* (
	part: Prompt.ToolResultPart,
	timestamp: number,
): Effect.fn.Return<ToolResultMessage, AiError.InvalidRequestError> {
	const content: ReadonlyArray<TextContent | ImageContent> =
		part.modelOutput === undefined
			? [{ type: "text", text: resultText(part.result) }]
			: yield* Effect.forEach(part.modelOutput, toContent, { concurrency: 1 });
	return {
		role: "toolResult",
		toolCallId: part.id,
		toolName: part.name,
		content: [...content],
		isError: part.isFailure,
		timestamp,
	};
});

/** A tool result as the text the model reads: a string as it is, anything else as JSON, nothing as "". */
function resultText(result: unknown): string {
	if (result === undefined) return "";
	return Predicate.isString(result) ? result : Formatter.formatJson(result);
}

function toPiTool(tool: Tool.Any): PiTool {
	return { name: tool.name, description: Tool.getDescription(tool) ?? "", parameters: Tool.getJsonSchema(tool) };
}

/** pi-ai reports no status or category for a failed request, only its text, so the reason is always unknown. */
function toAiError(method: string): (error: ModelRequestError) => AiError.AiError {
	return (error) =>
		AiError.make({ module: MODULE, method, reason: AiError.UnknownError.make({ description: error.message }) });
}

/** The stream parts of one pi-ai event. A block's id is its content index; a tool call keeps its own id. */
function eventParts(event: ResponseEvent): ReadonlyArray<Response.StreamPartEncoded> {
	// idiom-allow match: called for every event of a streamed response (each token); a switch costs no matcher per event.
	switch (event.type) {
		case "start":
			return [];
		case "text_start":
			return [{ type: "text-start", id: String(event.contentIndex) }];
		case "text_delta":
			return [{ type: "text-delta", id: String(event.contentIndex), delta: event.delta }];
		case "text_end":
			return [{ type: "text-end", id: String(event.contentIndex) }];
		case "thinking_start":
			return [{ type: "reasoning-start", id: String(event.contentIndex) }];
		case "thinking_delta":
			return [{ type: "reasoning-delta", id: String(event.contentIndex), delta: event.delta }];
		case "thinking_end":
			return [{ type: "reasoning-end", id: String(event.contentIndex) }];
		case "toolcall_start": {
			const block = event.partial.content[event.contentIndex];
			return block.type === "toolCall" ? [{ type: "tool-params-start", id: block.id, name: block.name }] : [];
		}
		case "toolcall_delta": {
			const block = event.partial.content[event.contentIndex];
			return block.type === "toolCall" ? [{ type: "tool-params-delta", id: block.id, delta: event.delta }] : [];
		}
		case "toolcall_end":
			return [{ type: "tool-params-end", id: event.toolCall.id }, toolCallPart(event.toolCall)];
		case "done":
			return finalParts(event.message);
	}
}

const contentPart = Match.type<TextContent | ThinkingContent | ToolCall>().pipe(
	Match.discriminatorsExhaustive("type")({
		text: (block): Response.PartEncoded => ({ type: "text", text: block.text }),
		thinking: (block): Response.PartEncoded => ({ type: "reasoning", text: block.thinking }),
		toolCall: (block): Response.PartEncoded => toolCallPart(block),
	}),
);

function toolCallPart(call: ToolCall): Response.ToolCallPartEncoded {
	return { type: "tool-call", id: call.id, name: call.name, params: call.arguments };
}

/** `error` and `aborted` never get here: they fail the request. `deferred` is never asked for. */
const FINISH_REASONS: Record<StopReason, Response.FinishReason> = {
	stop: "stop",
	length: "length",
	toolUse: "tool-calls",
	deferred: "other",
	pending: "unknown",
	error: "error",
	aborted: "error",
};

/** The parts that end a response: which model answered, why it stopped, and what it used. */
function finalParts(message: PiAssistantMessage): [Response.ResponseMetadataPartEncoded, Response.FinishPartEncoded] {
	const usage = message.usage;
	return [
		{
			type: "response-metadata",
			id: message.responseId,
			modelId: message.responseModel ?? message.model,
			timestamp: DateTime.formatIso(DateTime.makeUnsafe(message.timestamp)),
		},
		{
			type: "finish",
			reason: FINISH_REASONS[message.stopReason],
			usage: {
				// pi-ai's `input` counts the tokens that were neither read from nor written to the cache.
				inputTokens: {
					uncached: usage.input,
					total: usage.input + usage.cacheRead + usage.cacheWrite,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
				// pi-ai's `output` includes the reasoning tokens.
				outputTokens: {
					total: usage.output,
					text: usage.reasoning === undefined ? undefined : usage.output - usage.reasoning,
					reasoning: usage.reasoning,
				},
			},
		},
	];
}
