// Bridge "Effect serves Pi": a pi-ai provider whose chat requests run an effect/ai `LanguageModel`.

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	contentText,
	createAssistantMessageEventStream,
	createProvider,
	formatThrownValue,
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
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Exit,
	FiberSet,
	Formatter,
	type JsonSchema,
	Layer,
	Match,
	Predicate,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { type AiError, LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import type { ModelId, ProviderId } from "./ids.ts";
import type { ErrorReason } from "./request.ts";

/** One chat model of an Effect-backed provider: what pi-ai needs to know about it. Unset fields use the defaults. */
export interface EffectModel {
	readonly id: ModelId;
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
	readonly id: ProviderId;
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
export const make = Effect.fn("EffectProvider.make")(function* <E, R>(
	options: MakeOptions<E, R>,
): Effect.fn.Return<Provider, E, R | Scope.Scope> {
	const services = yield* Layer.build(options.layer);
	const clock = yield* Clock.Clock;
	const runFork = yield* Effect.provideContext(
		FiberSet.makeRuntime<LanguageModel.LanguageModel, void, ResponseFailure>(),
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
		models: Arr.map(options.models, (model) => toPiModel(options.id, model)),
		api: { stream: request, streamSimple: request },
	});
});

/** The `api` of every model of an Effect-backed provider. */
const API = "effect-ai";

function toPiModel(provider: ProviderId, model: EffectModel): Model<Api> {
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

/** What ends a response early: the model's failure, or an error part of its stream. */
type ResponseFailure = AiError.AiError | ErrorPart;

/** An error part of an effect/ai response stream, as a failure; its message is the error's. */
class ErrorPart extends Schema.TaggedError<ErrorPart, { readonly brand: unique symbol }>()("ErrorPart", {
	error: Schema.Defect(),
}) {
	override get message(): string {
		return formatThrownValue(this.error);
	}
}

/** Runs one request on the `LanguageModel` and writes its parts to `response`. Fails with what ended the response. */
const respond = Effect.fn("EffectProvider.respond")(function* (
	model: Model<Api>,
	transcript: TranscriptContext,
	toolChoice: ToolChoice | undefined,
	response: ResponseWriter,
): Effect.fn.Return<void, ResponseFailure, LanguageModel.LanguageModel> {
	const languageModel = yield* LanguageModel.LanguageModel;
	const systemInHistory =
		languageModel.supportsSystemMessagesInHistory === undefined
			? false
			: yield* languageModel.supportsSystemMessagesInHistory;
	// What every pi-ai API adapter does before a request: failed turns dropped, unanswered tool calls answered.
	const messages = transformMessages(resolveTranscript(transcript, systemInHistory).messages, model);
	const toolkit = yield* Toolkit.make(...Arr.map(getCurrentTools(transcript.messages), toClientTool));
	yield* languageModel
		.streamText({
			prompt: Prompt.fromMessages(Arr.flatMap(messages, toPromptMessages)),
			toolkit,
			toolChoice: toolChoice ?? "auto",
			// Pi runs tools. Effect only declares them, and hands every call over as the model made it.
			disableToolCallResolution: true,
			toolCallValidation: "deferred",
		})
		.pipe(Stream.runForEach(writePart(response)));
});

/** Writes each part of a response, failing at its error part. Per part, so untraced. */
function writePart(response: ResponseWriter) {
	return Effect.fnUntraced(function* (part: ResponsePart | Response.ErrorPart): Effect.fn.Return<void, ErrorPart> {
		if (part.type === "error") return yield* ErrorPart.make({ error: part.error });
		response.write(part);
	});
}

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
function toPromptMessages(message: Message, index: number): ReadonlyArray<Prompt.Message> {
	return Match.value(message).pipe(
		Match.discriminatorsExhaustive("role")({
			system: (system): ReadonlyArray<Prompt.Message> => {
				// The first message is the whole prompt; a later one is a change to it, which pi-ai frames for the model.
				const content = index === 0 ? getSystemMessageText(system) : renderSystemMessageUpdate(system);
				return content === "" ? [] : [Prompt.makeMessage("system", { content })];
			},
			user: (user): ReadonlyArray<Prompt.Message> => [
				Prompt.makeMessage("user", {
					content: Predicate.isString(user.content)
						? [Prompt.makePart("text", { text: user.content })]
						: Arr.map(user.content, toPromptPart),
				}),
			],
			assistant: (assistant): ReadonlyArray<Prompt.Message> => [
				Prompt.makeMessage("assistant", { content: Arr.map(assistant.content, toAssistantPart) }),
			],
			toolResult: (result): ReadonlyArray<Prompt.Message> => [
				Prompt.makeMessage("tool", {
					content: [
						Prompt.makePart("tool-result", {
							id: result.toolCallId,
							name: result.toolName,
							isFailure: result.isError,
							result: contentText(result.content),
							// Images cannot be part of `result`; `modelOutput` is what the model gets in its place.
							...(Arr.some(result.content, (block) => block.type === "image")
								? { modelOutput: Arr.map(result.content, toPromptPart) }
								: {}),
							providerExecuted: false,
						}),
					],
				}),
			],
		}),
	);
}

function toPromptPart(block: TextContent | ImageContent): Prompt.TextPart | Prompt.FilePart {
	return block.type === "text"
		? Prompt.makePart("text", { text: block.text })
		: Prompt.makePart("file", { mediaType: block.mimeType, data: block.data });
}

const toAssistantPart = Match.type<TextContent | ThinkingContent | ToolCall>().pipe(
	Match.discriminatorsExhaustive("type")({
		text: (block): Prompt.AssistantMessagePart => Prompt.makePart("text", { text: block.text }),
		thinking: (block): Prompt.AssistantMessagePart => Prompt.makePart("reasoning", { text: block.thinking }),
		toolCall: (block): Prompt.AssistantMessagePart =>
			Prompt.makePart("tool-call", {
				id: block.id,
				name: block.name,
				params: block.arguments,
				providerExecuted: false,
			}),
	}),
);

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
		// idiom-allow match: called for every part of a streamed response (each token); a switch costs no matcher per part.
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
	end(exit: Exit.Exit<void, ResponseFailure>): void {
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
					: Arr.some(message.content, (block) => block.type === "toolCall")
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
function describeFailure(cause: Cause.Cause<ResponseFailure>): Failure {
	if (Cause.hasInterruptsOnly(cause)) return { reason: "aborted", message: "Request was aborted" };
	return { reason: "error", message: formatThrownValue(Cause.squash(cause)) };
}

/**
 * The arguments of a finished tool call. Wire input: effect/ai hands over what the model sent, unvalidated. pi-ai
 * wants a JSON object and reports anything else through `argumentsError`, which fails Pi's argument validation.
 */
function toArguments(params: unknown): Pick<ToolCall, "arguments" | "argumentsError"> {
	return Predicate.isObject(params)
		? // A decode boundary: the object came out of the provider's JSON parser, so its values are JSON.
			{ arguments: params as JsonObject }
		: { arguments: {}, argumentsError: `Tool call arguments are not a JSON object: ${Formatter.formatJson(params)}` };
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
