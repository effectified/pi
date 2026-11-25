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
import { Clock, DateTime, Effect, Layer, Stream } from "effect";
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
export const make = Effect.fnUntraced(function* (
	ref: ModelRef,
	options?: Options,
): Effect.fn.Return<LanguageModel.LanguageModel, ModelNotFound, Models> {
	const models = yield* Models;
	const model = yield* getModel(ref);
	return yield* LanguageModel.make({
		generateText: Effect.fnUntraced(
			function* (request) {
				const { context, toolChoice } = yield* toPiRequest(request, model, "generateText");
				const message = yield* completeSimple(model, context, { ...options, toolChoice }).pipe(
					Effect.mapError(toAiError("generateText")),
				);
				return [...message.content.map(contentPart), ...finalParts(message)];
			},
			Effect.provideService(Models, models),
		),
		streamText: (request) =>
			Stream.unwrap(
				Effect.map(toPiRequest(request, model, "streamText"), ({ context, toolChoice }) =>
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

const MODULE = "PiLanguageModel";

interface PiRequest {
	readonly context: PiContext;
	readonly toolChoice: ToolChoice | undefined;
}

/** One effect/ai request as pi-ai's request input. Fails for what pi-ai cannot be asked. */
function toPiRequest(
	request: LanguageModel.ProviderOptions,
	model: Model<Api>,
	method: string,
): Effect.Effect<PiRequest, AiError.AiError> {
	return Effect.gen(function* () {
		if (request.responseFormat.type === "json") {
			return yield* notCarried("responseFormat", "pi-ai has no structured output option");
		}
		const toolChoice = yield* toToolChoice(request);
		const timestamp = yield* Clock.currentTimeMillis;
		const messages: Message[] = [];
		let systemPrompt: string | undefined;
		for (const message of request.prompt.content) {
			switch (message.role) {
				case "system":
					// The first message of a prompt is pi-ai's system prompt; a later one stays where it is.
					if (messages.length === 0 && systemPrompt === undefined) systemPrompt = message.content;
					else messages.push({ role: "system", content: message.content, timestamp });
					break;
				case "user":
					messages.push({ role: "user", content: yield* Effect.forEach(message.content, toContent), timestamp });
					break;
				case "assistant":
					messages.push(toAssistantMessage(message, model, timestamp));
					break;
				case "tool":
					for (const part of message.content) {
						// An approval response has no pi-ai counterpart; effect/ai resolves it before the request.
						if (part.type === "tool-result") messages.push(yield* toToolResult(part, timestamp));
					}
					break;
			}
		}
		return { context: { systemPrompt, messages, tools: request.tools.map(toPiTool) }, toolChoice };
	}).pipe(Effect.mapError((reason) => AiError.make({ module: MODULE, method, reason })));
}

function notCarried(parameter: string, description: string): AiError.InvalidRequestError {
	return new AiError.InvalidRequestError({ parameter, description });
}

/** pi-ai's provider-neutral tool choice is `auto` or `none`; a request without tools leaves it to the provider. */
function toToolChoice(
	request: LanguageModel.ProviderOptions,
): Effect.Effect<ToolChoice | undefined, AiError.InvalidRequestError> {
	const choice = request.toolChoice;
	if (request.tools.length === 0) return Effect.succeed(undefined);
	if (choice === "auto" || choice === "none") return Effect.succeed(choice);
	// effect/ai's tool choice is an untagged union we do not own, so `in` is the only way to tell its object forms
	// apart. `oneOf` has already narrowed `request.tools`; only its mode is left to carry.
	if (typeof choice === "object" && "oneOf" in choice && choice.mode !== "required") return Effect.succeed("auto");
	return Effect.fail(notCarried("toolChoice", "pi-ai's provider-neutral tool choice cannot force a tool call"));
}

function toContent(
	part: Prompt.TextPart | Prompt.FilePart,
): Effect.Effect<TextContent | ImageContent, AiError.InvalidRequestError> {
	if (part.type === "text") return Effect.succeed({ type: "text", text: part.text });
	if (!part.mediaType.startsWith("image/") || part.data instanceof URL) {
		return Effect.fail(notCarried("prompt", `pi-ai takes inline images only, not a ${part.mediaType} file or a URL`));
	}
	return Effect.succeed({
		type: "image",
		mimeType: part.mediaType,
		data: typeof part.data === "string" ? withoutDataUrlPrefix(part.data) : Base64.encode(part.data),
	});
}

/** effect/ai accepts base64 text with or without a `data:<type>;base64,` prefix; pi-ai wants the bare base64. */
function withoutDataUrlPrefix(data: string): string {
	return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

function toAssistantMessage(
	message: Prompt.AssistantMessage,
	model: Model<Api>,
	timestamp: number,
): PiAssistantMessage {
	const content: PiAssistantMessage["content"] = [];
	for (const part of message.content) {
		if (part.type === "text") content.push({ type: "text", text: part.text });
		else if (part.type === "reasoning") content.push({ type: "thinking", thinking: part.text });
		else if (part.type === "tool-call" && !part.providerExecuted) {
			// A decode boundary: a prompt's tool call params are the JSON object a model sent, typed `unknown`.
			content.push({ type: "toolCall", id: part.id, name: part.name, arguments: part.params as JsonObject });
		}
		// Files, provider-executed calls and their results, and approval requests have no place in a pi-ai message.
	}
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function toToolResult(
	part: Prompt.ToolResultPart,
	timestamp: number,
): Effect.Effect<ToolResultMessage, AiError.InvalidRequestError> {
	const content: Effect.Effect<Array<TextContent | ImageContent>, AiError.InvalidRequestError> = part.modelOutput ===
	undefined
		? Effect.succeed([{ type: "text", text: resultText(part.result) }])
		: Effect.forEach(part.modelOutput, toContent);
	return Effect.map(content, (content) => ({
		role: "toolResult",
		toolCallId: part.id,
		toolName: part.name,
		content,
		isError: part.isFailure,
		timestamp,
	}));
}

/** A tool result as the text the model reads: a string as it is, anything else as JSON, nothing as "". */
function resultText(result: unknown): string {
	if (result === undefined) return "";
	return typeof result === "string" ? result : JSON.stringify(result);
}

function toPiTool(tool: Tool.Any): PiTool {
	return { name: tool.name, description: Tool.getDescription(tool) ?? "", parameters: Tool.getJsonSchema(tool) };
}

/** pi-ai reports no status or category for a failed request, only its text, so the reason is always unknown. */
function toAiError(method: string): (error: ModelRequestError) => AiError.AiError {
	return (error) =>
		AiError.make({ module: MODULE, method, reason: new AiError.UnknownError({ description: error.message }) });
}

/** The stream parts of one pi-ai event. A block's id is its content index; a tool call keeps its own id. */
function eventParts(event: ResponseEvent): ReadonlyArray<Response.StreamPartEncoded> {
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

function contentPart(block: TextContent | ThinkingContent | ToolCall): Response.PartEncoded {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return { type: "reasoning", text: block.thinking };
		case "toolCall":
			return toolCallPart(block);
	}
}

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
