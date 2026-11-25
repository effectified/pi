// Bridge "Effect serves Pi": a pi-ai provider whose chat requests run an effect/ai `LanguageModel`.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	contentText,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentTools,
	getSystemMessageText,
	type ImageContent,
	type JsonObject,
	type Message,
	type Model,
	type Tool as PiTool,
	type Provider,
	type ProviderAuth,
	renderSystemMessageUpdate,
	resolveTranscript,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	ToolCallArgumentsStream,
	type ToolChoice,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { Cause, Clock, Effect, Exit, FiberSet, type JsonSchema, Layer, Predicate, type Scope, Stream } from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import type { ErrorReason } from "./request.ts";

/** One chat model of an Effect-backed provider: what pi-ai needs to know about it. Unset fields use the defaults. */
export interface EffectModel {
	readonly id: Model<Api>["id"];
	/** Display name. Default: `id`. */
	readonly name?: Model<Api>["name"];
	/** The size of the model's context window in tokens; Pi compacts a conversation against it. */
	readonly contextWindow: Model<Api>["contextWindow"];
	/** The most output tokens one response may have. */
	readonly maxTokens: Model<Api>["maxTokens"];
	/** Whether the model reasons. Default: false. */
	readonly reasoning?: Model<Api>["reasoning"];
	/** What the model reads. Default: text only. */
	readonly input?: Model<Api>["input"];
	/** Prices per million tokens, for pi-ai's cost of each response. Default: free. */
	readonly cost?: Model<Api>["cost"];
}

/** What `make` builds a provider from. */
export interface MakeOptions<E, R> {
	/** The provider id models are looked up under. */
	readonly id: string;
	/** Display name. Default: `id`. */
	readonly name?: string;
	/** The chat models the provider lists. `layer` serves every one of them. */
	readonly models: readonly EffectModel[];
	/** The effect/ai model that answers, with its client and credentials. */
	readonly layer: Layer.Layer<LanguageModel.LanguageModel, E, R>;
}

/** The smallest valid pi-ai auth: always configured, resolving to no key, no header and no base URL. */
const KEYLESS: ProviderAuth = { apiKey: { name: "Effect layer", resolve: () => Promise.resolve({ auth: {} }) } };

/**
 * A pi-ai provider (built with pi-ai's `createProvider`) whose chat requests run the `LanguageModel` of
 * `options.layer`, so an effect/ai provider or a product's router can drive a Pi harness.
 *
 * The layer is built once, here, in the caller's scope. Each request runs in a fiber of that scope with the services
 * of the fiber that called `make`: aborting the request interrupts its fiber, and closing the scope interrupts every
 * open request and releases the layer. The provider needs no key: the layer owns its credentials.
 *
 * Carried: the transcript (system prompt, user text and images, assistant text, reasoning and tool calls, tool
 * results), the current tools with their JSON Schema, `toolChoice`, pi-ai's event sequence, usage with pi-ai's cost,
 * and the stop reason. Tools are declared to the model and never run by Effect: Pi runs them. Not carried, because
 * effect/ai takes them from the model's own layer or has no place for them: `temperature`, `maxTokens`, `reasoning`
 * and the other request options, pi-ai's replay signatures, and provider-executed tool calls, files and sources of
 * the response.
 */
export function make<E, R>(options: MakeOptions<E, R>): Effect.Effect<Provider, E, R | Scope.Scope> {
	return Effect.gen(function* () {
		const services = yield* Layer.build(options.layer);
		const clock = yield* Clock.Clock;
		const runFork = yield* Effect.provideContext(
			FiberSet.makeRuntime<LanguageModel.LanguageModel, void, unknown>(),
			services,
		);
		const request = (
			model: Model<Api>,
			transcript: TranscriptContext,
			requestOptions?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const events = createAssistantMessageEventStream();
			const response = new ResponseWriter(events, model, clock.currentTimeMillisUnsafe());
			// The observer also runs for a request that never started (an aborted signal, a closed scope), so the
			// pi-ai stream always ends.
			runFork(respond(model, transcript, requestOptions?.toolChoice, response), {
				signal: requestOptions?.signal,
			}).addObserver((exit) => response.end(exit));
			return events;
		};
		return createProvider({
			id: options.id,
			name: options.name,
			auth: KEYLESS,
			models: options.models.map((model) => toPiModel(options.id, model)),
			api: { stream: request, streamSimple: request },
		});
	});
}

/** The `api` of every model of an Effect-backed provider. */
const API = "effect-ai";

function toPiModel(provider: string, model: EffectModel): Model<Api> {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: API,
		provider,
		// pi-ai requires a base URL; nothing reads this one, the layer's client knows where to go.
		baseUrl: "effect-ai://layer",
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** Runs one request on the `LanguageModel` and writes its parts to `response`. Fails with what ended the response. */
const respond = Effect.fnUntraced(function* (
	model: Model<Api>,
	transcript: TranscriptContext,
	toolChoice: ToolChoice | undefined,
	response: ResponseWriter,
): Effect.fn.Return<void, unknown, LanguageModel.LanguageModel> {
	const languageModel = yield* LanguageModel.LanguageModel;
	const systemInHistory =
		languageModel.supportsSystemMessagesInHistory === undefined
			? false
			: yield* languageModel.supportsSystemMessagesInHistory;
	// What every pi-ai API adapter does before a request: failed turns dropped, unanswered tool calls answered.
	const messages = transformMessages(resolveTranscript(transcript, systemInHistory).messages, model);
	const toolkit = yield* Toolkit.make(...getCurrentTools(transcript.messages).map(toClientTool));
	yield* languageModel
		.streamText({
			prompt: Prompt.fromMessages(messages.flatMap(toPromptMessages)),
			toolkit,
			toolChoice: toolChoice ?? "auto",
			// Pi runs tools. Effect only declares them, and hands every call over as the model made it.
			disableToolCallResolution: true,
			toolCallValidation: "deferred",
		})
		.pipe(
			Stream.runForEach((part) =>
				part.type === "error" ? Effect.fail(part.error) : Effect.sync(() => response.write(part)),
			),
		);
});

/** A pi-ai tool as an effect/ai tool the application runs: declared to the model, with no handler. */
function toClientTool(tool: PiTool) {
	return Tool.dynamic(tool.name, {
		description: tool.description,
		// A decode boundary: pi-ai types tool parameters as `object`, Effect as its own JSON Schema record.
		parameters: tool.parameters as JsonSchema.JsonSchema,
		execution: "client",
	});
}

/** One pi-ai message as effect/ai prompt messages; a system message without text (tools only) is none. */
function toPromptMessages(message: Message, index: number): Prompt.Message[] {
	switch (message.role) {
		case "system": {
			// The first message is the whole prompt; a later one is a change to it, which pi-ai frames for the model.
			const content = index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message);
			return content === "" ? [] : [Prompt.makeMessage("system", { content })];
		}
		case "user":
			return [
				Prompt.makeMessage("user", {
					content:
						typeof message.content === "string"
							? [Prompt.makePart("text", { text: message.content })]
							: message.content.map(toPromptPart),
				}),
			];
		case "assistant":
			return [Prompt.makeMessage("assistant", { content: message.content.map(toAssistantPart) })];
		case "toolResult":
			return [
				Prompt.makeMessage("tool", {
					content: [
						Prompt.makePart("tool-result", {
							id: message.toolCallId,
							name: message.toolName,
							isFailure: message.isError,
							result: contentText(message.content),
							// Images cannot be part of `result`; `modelOutput` is what the model gets in its place.
							...(message.content.some((block) => block.type === "image")
								? { modelOutput: message.content.map(toPromptPart) }
								: {}),
							providerExecuted: false,
						}),
					],
				}),
			];
	}
}

function toPromptPart(block: TextContent | ImageContent): Prompt.TextPart | Prompt.FilePart {
	return block.type === "text"
		? Prompt.makePart("text", { text: block.text })
		: Prompt.makePart("file", { mediaType: block.mimeType, data: block.data });
}

function toAssistantPart(block: TextContent | ThinkingContent | ToolCall): Prompt.AssistantMessagePart {
	switch (block.type) {
		case "text":
			return Prompt.makePart("text", { text: block.text });
		case "thinking":
			return Prompt.makePart("reasoning", { text: block.thinking });
		case "toolCall":
			return Prompt.makePart("tool-call", {
				id: block.id,
				name: block.name,
				params: block.arguments,
				providerExecuted: false,
			});
	}
}

/** A part `ResponseWriter` takes. An `error` part ends the response instead. */
type ResponsePart = Exclude<Response.StreamPart<Record<string, Tool.Any>, "deferred">, Response.ErrorPart>;

/** A content block that is still receiving deltas, and where it sits in the message. */
interface OpenBlock<TBlock> {
	readonly contentIndex: number;
	readonly block: TBlock;
}

/**
 * Writes one effect/ai response into a pi-ai event stream as pi-ai's event sequence: `start`, then the start, delta
 * and end events of each text, thinking and tool call block, then `done` or `error`. The message of every event is
 * the one live message, as in pi-ai's own adapters.
 */
class ResponseWriter {
	readonly #events: AssistantMessageEventStream;
	readonly #model: Model<Api>;
	readonly #message: AssistantMessage;
	readonly #texts = new Map<string, OpenBlock<TextContent>>();
	readonly #thoughts = new Map<string, OpenBlock<ThinkingContent>>();
	readonly #calls = new Map<string, OpenBlock<ToolCall> & { readonly text: ToolCallArgumentsStream }>();
	#finishReason: Response.FinishReason | undefined;

	constructor(events: AssistantMessageEventStream, model: Model<Api>, timestamp: number) {
		this.#events = events;
		this.#model = model;
		this.#message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: toPiUsage(model, undefined),
			stopReason: "pending",
			timestamp,
		};
		events.push({ type: "start", partial: this.#message });
	}

	/** Applies one part of the response to the message and emits the pi-ai event it stands for, if any. */
	write(part: ResponsePart): void {
		const partial = this.#message;
		switch (part.type) {
			case "response-metadata":
				if (part.id !== undefined) partial.responseId = part.id;
				if (part.modelId !== undefined) partial.responseModel = part.modelId;
				return;
			case "text-start": {
				const block: TextContent = { type: "text", text: "" };
				const contentIndex = partial.content.push(block) - 1;
				this.#texts.set(part.id, { contentIndex, block });
				this.#events.push({ type: "text_start", contentIndex, partial });
				return;
			}
			case "text-delta": {
				const open = this.#texts.get(part.id);
				if (open === undefined) return;
				open.block.text += part.delta;
				this.#events.push({ type: "text_delta", contentIndex: open.contentIndex, delta: part.delta, partial });
				return;
			}
			case "text-end": {
				const open = this.#texts.get(part.id);
				if (open === undefined) return;
				this.#texts.delete(part.id);
				this.#events.push({
					type: "text_end",
					contentIndex: open.contentIndex,
					content: open.block.text,
					partial,
				});
				return;
			}
			case "reasoning-start": {
				const block: ThinkingContent = { type: "thinking", thinking: "" };
				const contentIndex = partial.content.push(block) - 1;
				this.#thoughts.set(part.id, { contentIndex, block });
				this.#events.push({ type: "thinking_start", contentIndex, partial });
				return;
			}
			case "reasoning-delta": {
				const open = this.#thoughts.get(part.id);
				if (open === undefined) return;
				open.block.thinking += part.delta;
				this.#events.push({
					type: "thinking_delta",
					contentIndex: open.contentIndex,
					delta: part.delta,
					partial,
				});
				return;
			}
			case "reasoning-end": {
				const open = this.#thoughts.get(part.id);
				if (open === undefined) return;
				this.#thoughts.delete(part.id);
				this.#events.push({
					type: "thinking_end",
					contentIndex: open.contentIndex,
					content: open.block.thinking,
					partial,
				});
				return;
			}
			case "tool-params-start":
				// Pi would run a provider-executed call a second time, so it never becomes a pi-ai tool call.
				if (!part.providerExecuted) this.#openCall(part.id, part.name);
				return;
			case "tool-params-delta": {
				const open = this.#calls.get(part.id);
				if (open === undefined) return;
				open.block.arguments = open.text.append(part.delta);
				this.#events.push({
					type: "toolcall_delta",
					contentIndex: open.contentIndex,
					delta: part.delta,
					partial,
				});
				return;
			}
			case "tool-call": {
				if (part.providerExecuted) return;
				// A provider that does not stream parameters sends the call alone.
				const open = this.#calls.get(part.id) ?? this.#openCall(part.id, part.name);
				this.#calls.delete(part.id);
				Object.assign(open.block, toArguments(part.params));
				this.#events.push({
					type: "toolcall_end",
					contentIndex: open.contentIndex,
					toolCall: open.block,
					partial,
				});
				return;
			}
			case "finish":
				this.#finishReason = part.reason;
				partial.rawStopReason = part.reason;
				partial.usage = toPiUsage(this.#model, part.usage);
				return;
			default:
				// The end of a call's parameters adds nothing to the call that follows it. Results of
				// provider-executed tools, approval requests, files and sources have no place in a pi-ai message.
				return;
		}
	}

	/** Ends the pi-ai stream with `done`, or with `error` when the request failed, was aborted or was refused. */
	end(exit: Exit.Exit<void, unknown>): void {
		const message = this.#message;
		const failure = Exit.isSuccess(exit) ? refusal(this.#finishReason) : describeFailure(exit.cause);
		if (failure !== undefined) {
			message.stopReason = failure.reason;
			message.errorMessage = failure.message;
			this.#events.push({ type: "error", reason: failure.reason, error: message });
		} else {
			// Pi reads `toolUse` as "run these calls"; providers do not all report it when a call is present.
			const reason =
				this.#finishReason === "length"
					? "length"
					: message.content.some((block) => block.type === "toolCall")
						? "toolUse"
						: "stop";
			message.stopReason = reason;
			this.#events.push({ type: "done", reason, message });
		}
		this.#events.end();
	}

	#openCall(id: string, name: string): OpenBlock<ToolCall> & { readonly text: ToolCallArgumentsStream } {
		const partial = this.#message;
		const block: ToolCall = { type: "toolCall", id, name, arguments: {} };
		const open = { contentIndex: partial.content.push(block) - 1, block, text: new ToolCallArgumentsStream() };
		this.#calls.set(id, open);
		this.#events.push({ type: "toolcall_start", contentIndex: open.contentIndex, partial });
		return open;
	}
}

/** How a failed response ends in pi-ai: its stop reason and the text of `errorMessage`. */
interface Failure {
	readonly reason: ErrorReason;
	readonly message: string;
}

/** A response the model finished without an answer to use: a provider error or a content filter. */
function refusal(reason: Response.FinishReason | undefined): Failure | undefined {
	return reason === "error" || reason === "content-filter"
		? { reason: "error", message: `The model stopped with finish reason "${reason}"` }
		: undefined;
}

/** Interruption (the request's abort signal, the provider's closed scope) is pi-ai's `aborted`; the rest is `error`. */
function describeFailure(cause: Cause.Cause<unknown>): Failure {
	if (Cause.hasInterruptsOnly(cause)) return { reason: "aborted", message: "Request was aborted" };
	const error = Cause.squash(cause);
	return { reason: "error", message: error instanceof Error ? error.message : String(error) };
}

/**
 * The arguments of a finished tool call. Wire input: effect/ai hands over what the model sent, unvalidated. pi-ai
 * wants a JSON object and reports anything else through `argumentsError`, which fails Pi's argument validation.
 */
function toArguments(params: unknown): Pick<ToolCall, "arguments" | "argumentsError"> {
	return Predicate.isObject(params)
		? // A decode boundary: the object came out of the provider's JSON parser, so its values are JSON.
			{ arguments: params as JsonObject }
		: { arguments: {}, argumentsError: `Tool call arguments are not a JSON object: ${JSON.stringify(params)}` };
}

/** effect/ai usage as pi-ai usage, priced with the model's rates. No usage yet is all zeros. */
function toPiUsage(model: Model<Api>, usage: Response.Usage | undefined): Usage {
	const cacheRead = usage?.inputTokens.cacheRead ?? 0;
	const cacheWrite = usage?.inputTokens.cacheWrite ?? 0;
	// pi-ai's `input` counts the tokens that were neither read from nor written to the cache.
	const input = usage?.inputTokens.uncached ?? Math.max(0, (usage?.inputTokens.total ?? 0) - cacheRead - cacheWrite);
	const output = usage?.outputTokens.total ?? 0;
	const result: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (usage?.outputTokens.reasoning !== undefined) result.reasoning = usage.outputTokens.reasoning;
	result.cost = calculateCost(model, result);
	return result;
}
