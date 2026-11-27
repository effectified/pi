// Chat requests in Effect terms: a response as a Stream of pi-ai's events, or as an Effect of its final message, and
// the Sink that folds the one into the other.

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
	StreamOptions,
} from "@earendil-works/pi-ai";
import { Effect, Option, Sink, Stream } from "effect";
import { ModelRequestError } from "./errors.ts";
import { Models } from "./models.ts";

/** pi-ai's request options without `signal`: the fiber owns cancellation, and interrupting it aborts the request. */
export type RequestOptions<TOptions> = TOptions & { readonly signal?: never };

/** An event of a response that has not failed. pi-ai's `error` event is the failure of the Stream instead. */
export type ResponseEvent = Exclude<AssistantMessageEvent, { type: "error" }>;

/** Why a response failed: the `reason` of pi-ai's `error` event, `error` or `aborted`. */
export type ErrorReason = Extract<AssistantMessageEvent, { type: "error" }>["reason"];

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
	return responseEvents((models, signal) => {
		// Checked alone: the cast below cannot see whether pi-ai still names its abort signal `signal`.
		const abort = { signal } satisfies Pick<StreamOptions, "signal">;
		// TypeScript cannot resolve the conditional type of one API's options here; the spread only adds `signal`.
		return models.stream(model, context, { ...options, ...abort } as ModelsApiStreamOptions<TApi>);
	});
}

/** The final message of one response of `model`, with the error and interruption rules of `stream`. */
export const complete = Effect.fn("Request.complete")(function* <TApi extends Api>(
	model: Model<TApi>,
	context: PiContext,
	options?: RequestOptions<ModelsApiStreamOptions<TApi>>,
): Effect.fn.Return<AssistantMessage, ModelRequestError, Models> {
	return yield* Stream.run(stream(model, context, options), finalMessage);
});

/** `stream` with pi-ai's provider-neutral options (`reasoning`, `toolChoice`) instead of one API's own. */
export function streamSimple(
	model: Model<Api>,
	context: PiContext,
	options?: RequestOptions<ModelsSimpleStreamOptions>,
): Stream.Stream<ResponseEvent, ModelRequestError, Models> {
	return responseEvents((models, signal) => models.streamSimple(model, context, { ...options, signal }));
}

/** `complete` with pi-ai's provider-neutral options (`reasoning`, `toolChoice`) instead of one API's own. */
export const completeSimple = Effect.fn("Request.completeSimple")(function* (
	model: Model<Api>,
	context: PiContext,
	options?: RequestOptions<ModelsSimpleStreamOptions>,
): Effect.fn.Return<AssistantMessage, ModelRequestError, Models> {
	return yield* Stream.run(streamSimple(model, context, options), finalMessage);
});

/**
 * The message of the `done` event that ends a response's events: what `complete` runs `stream` into. Run it on a
 * stream a consumer also reads (`Stream.tap` the deltas to a UI) to get the final message as well. pi-ai ends every
 * response in `done` or `error`, and `error` fails the stream first, so events that end otherwise are a defect.
 */
export const finalMessage: Sink.Sink<AssistantMessage, ResponseEvent> = Sink.last<ResponseEvent>().pipe(
	Sink.mapEffect((last) =>
		Option.isSome(last) && last.value.type === "done"
			? Effect.succeed(last.value.message)
			: Effect.die(new Error("pi-ai ended a response without a done or error event")),
	),
);

/** The events of the pi-ai response `start` begins. Closing the Stream's scope, for any reason, aborts `signal`. */
function responseEvents(
	start: (models: MutableModels, signal: AbortSignal) => AssistantMessageEventStream,
): Stream.Stream<ResponseEvent, ModelRequestError, Models> {
	return Stream.unwrap(
		Effect.gen(function* () {
			const models = yield* Models;
			// Aborted when the Stream's scope closes.
			const signal = yield* Effect.abortSignal;
			// pi-ai's event streams never reject: every failure is an `error` event. A rejection is a defect.
			return Stream.fromAsyncIterable(start(models, signal), (cause) => cause).pipe(
				Stream.orDie,
				Stream.mapEffect(failOnError),
			);
		}),
	);
}

/** One event of a response, or the failure its `error` event stands for. Per event, so untraced. */
const failOnError = Effect.fnUntraced(function* (
	event: AssistantMessageEvent,
): Effect.fn.Return<ResponseEvent, ModelRequestError> {
	if (event.type === "error") return yield* ModelRequestError.make({ reason: event.reason, response: event.error });
	return event;
});
