// `@effectified/pi-chord/watch`: Chord's watchables as Streams: the value at attachment, then its changes, until the
// watch ends or the stream's scope closes.

import type { Context } from "@earendil-works/chord/context";
import type {
	NativeWatchable,
	NativeWatchCall,
	NativeWatchHandle,
	Watchable,
	WatchCall,
	WatchEnd,
	WatchHandle,
} from "@earendil-works/chord/watch";
import { Cause, Effect, Queue, Schema, Stream } from "effect";
import { absurd } from "effect/Function";
import { chordCall } from "./call.ts";
import type { ChordCallError } from "./errors.ts";

// Chord's watch types (`Watchable`, `WatchHandle`, `WatchCall`, `WatchEnd`, their native forms).
export type * from "@earendil-works/chord/watch";

/** A watch ended for good with a failure: its listener failed, or its source failed and cannot recover. */
export class WatchFailed extends Schema.TaggedError<WatchFailed>()("WatchFailed", {
	cause: Schema.Defect(),
}) {}

/** What a watch Stream fails with: the watch could not be acquired, or it ended with a failure. */
export type WatchError = ChordCallError | WatchFailed;

/**
 * One element of `changes`: Chord's value call without its tag. The first element is the value at attachment,
 * without ops; each later one the newest value and the ops that turn the element before into it. `retired` says the
 * watched document was retired since the element before.
 */
export type Change<T> = Omit<Extract<WatchCall<T>, { readonly kind: "value" }>, "kind">;

/**
 * A Chord watchable (a document, a derive, a member of a reference) as a Stream of its changes. Chord delivers one
 * change at a time and folds what changes meanwhile into the next, so a slow consumer gets fewer, larger changes and
 * always the newest value. A `failed` call (the source cannot compute its value now) fails the stream with
 * `WatchFailed`; so does a watch that ends with a failure. The stream ends when the watch ends otherwise (its source
 * ended), and closing its scope stops the watch.
 */
export function changes<T>(watchable: Watchable<T>): Stream.Stream<Change<T>, WatchError> {
	return follow<T, WatchCall<T>, Change<T>>(
		(context) => watchable.watch(context),
		(value) => ({ value, ops: [], retired: false }),
		({ value, ops, retired }) => ({ value, ops, retired }),
	);
}

/**
 * A Chord native watchable (an in-process value: a registry's composition, a host's activity, a follower) as a Stream
 * of its values: the value at attachment, then each new one, in order. Otherwise as `changes`.
 */
export function values<T>(watchable: NativeWatchable<T>): Stream.Stream<T, WatchError> {
	return follow<T, NativeWatchCall<T>, T>(
		(context) => watchable.watch(context),
		(value) => value,
		({ value }) => value,
	);
}

/** A watch handle of either kind, as `follow` drives it. */
type Handle<T, C> = Pick<WatchHandle<T> | NativeWatchHandle<T>, "value" | "stop" | "closed"> & {
	readonly start: (listener: (call: C) => Promise<void>) => void;
};

/** The Stream of a watch: its first element from the handle's value, each value call's from `element`. */
function follow<T, C extends WatchCall<T> | NativeWatchCall<T>, A>(
	acquire: (context: Context) => Promise<Handle<T, C>>,
	first: (value: T) => A,
	element: (call: Extract<C, { readonly kind: "value" }>) => A,
): Stream.Stream<A, WatchError> {
	return Stream.callback<A, WatchError>(
		(queue) =>
			Effect.gen(function* () {
				const watch = yield* Effect.acquireRelease(chordCall(acquire), (acquired) =>
					Effect.promise(() => acquired.stop()),
				);
				yield* Queue.offer(queue, first(watch.value));
				// The listener returns once the consumer took the element before: Chord folds what changes until then. An
				// offer cut off because the stream's scope closed is dropped.
				watch.start(async (call) => {
					switch (call.kind) {
						case "value":
							await Effect.runPromiseExit(
								Queue.offer(queue, element(call as Extract<C, { readonly kind: "value" }>)),
							);
							return;
						case "failed":
							Queue.failCauseUnsafe(queue, failure(call.error));
							return;
						default:
							absurd(call);
					}
				});
				void watch.closed.then((end) => finish(queue, end));
			}),
		{ bufferSize: 1, strategy: "suspend" },
	);
}

/** Ends `queue` as the watch ended: a failure fails it, any other end ends it. */
function finish<A>(queue: Queue.Queue<A, WatchError | Cause.Done>, end: WatchEnd): void {
	switch (end.kind) {
		case "listener_error":
		case "failed":
			Queue.failCauseUnsafe(queue, failure(end.error));
			return;
		case "stopped":
		case "aborted":
		case "ended":
			Queue.endUnsafe(queue);
			return;
		default:
			absurd(end);
	}
}

/** The cause a watch failure fails its Stream with. */
function failure(error: unknown): Cause.Cause<WatchFailed> {
	return Cause.fail(new WatchFailed({ cause: error }));
}
