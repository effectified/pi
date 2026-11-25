// Chat requests in Effect terms: a response as a Stream of pi-ai's events, or as an Effect of its final message.

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ModelsApiStreamOptions,
	ModelsSimpleStreamOptions,
	MutableModels,
	Context as PiContext,
} from "@earendil-works/pi-ai";
import { Effect, Option, Stream } from "effect";
import { ModelRequestError } from "./errors.ts";
import { Models } from "./models.ts";

/** pi-ai's request options without `signal`: the fiber owns cancellation, and interrupting it aborts the request. */
export type RequestOptions<TOptions> = TOptions & { readonly signal?: never };

/** An event of a response that has not failed. pi-ai's `error` event is the failure of the Stream instead. */
export type ResponseEvent = Exclude<AssistantMessageEvent, { type: "error" }>;

/**
 * Streams one response of `model` with the options of the model's own API. The events arrive as pi-ai emits them and
 * `done` is the last one. A response that ends in pi-ai's `error` event fails with `ModelRequestError`. Interrupting
 * the consumer, or ending the Stream early, aborts the provider request.
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: PiContext,
	options?: RequestOptions<ModelsApiStreamOptions<TApi>>,
): Stream.Stream<ResponseEvent, ModelRequestError, Models> {
	return responseEvents((models, signal) =>
		// TypeScript cannot resolve the conditional type of one API's options here; the spread only adds `signal`.
		models.stream(model, context, { ...options, signal } as ModelsApiStreamOptions<TApi>),
	);
}

/** The final message of one response of `model`, with the error and interruption rules of `stream`. */
export function complete<TApi extends Api>(
	model: Model<TApi>,
	context: PiContext,
	options?: RequestOptions<ModelsApiStreamOptions<TApi>>,
): Effect.Effect<AssistantMessage, ModelRequestError, Models> {
	return finalMessage(stream(model, context, options));
}

/** `stream` with pi-ai's provider-neutral options (`reasoning`, `toolChoice`) instead of one API's own. */
export function streamSimple(
	model: Model<Api>,
	context: PiContext,
	options?: RequestOptions<ModelsSimpleStreamOptions>,
): Stream.Stream<ResponseEvent, ModelRequestError, Models> {
	return responseEvents((models, signal) => models.streamSimple(model, context, { ...options, signal }));
}

/** `complete` with pi-ai's provider-neutral options (`reasoning`, `toolChoice`) instead of one API's own. */
export function completeSimple(
	model: Model<Api>,
	context: PiContext,
	options?: RequestOptions<ModelsSimpleStreamOptions>,
): Effect.Effect<AssistantMessage, ModelRequestError, Models> {
	return finalMessage(streamSimple(model, context, options));
}

/** The events of the pi-ai response `start` begins. Closing the Stream's scope, for any reason, aborts `signal`. */
function responseEvents(
	start: (models: MutableModels, signal: AbortSignal) => AssistantMessageEventStream,
): Stream.Stream<ResponseEvent, ModelRequestError, Models> {
	return Stream.unwrap(
		Effect.gen(function* () {
			const models = yield* Models;
			const controller = yield* Effect.acquireRelease(
				Effect.sync(() => new AbortController()),
				(controller) => Effect.sync(() => controller.abort()),
			);
			// pi-ai's event streams never reject: every failure is an `error` event. A rejection is a defect.
			return Stream.fromAsyncIterable(start(models, controller.signal), (cause) => cause).pipe(
				Stream.orDie,
				Stream.mapEffect((event) =>
					event.type === "error"
						? Effect.fail(new ModelRequestError({ reason: event.reason, response: event.error }))
						: Effect.succeed(event),
				),
			);
		}),
	);
}

/** The message of the `done` event that ends `events`. */
function finalMessage<E, R>(events: Stream.Stream<ResponseEvent, E, R>): Effect.Effect<AssistantMessage, E, R> {
	return Effect.flatMap(Stream.runLast(events), (last) =>
		Option.isSome(last) && last.value.type === "done"
			? Effect.succeed(last.value.message)
			: // pi-ai's protocol ends every response in `done` or `error`; anything else is a broken provider.
				Effect.die(new Error("pi-ai ended a response without a done or error event")),
	);
}
