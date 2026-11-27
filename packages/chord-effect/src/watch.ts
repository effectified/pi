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
import { Cause, Effect, Match, Queue, Schema, Stream } from "effect";
import { chordCall } from "./call.ts";
import type { ChordCallError } from "./errors.ts";

// Chord's watch types (`Watchable`, `WatchHandle`, `WatchCall`, `WatchEnd`, their native forms).
export type * from "@earendil-works/chord/watch";

/** A watch ended for good with a failure: its listener failed, or its source failed and cannot recover. */
export class WatchFailed extends Schema.TaggedError<WatchFailed, { readonly brand: unique symbol }>()("WatchFailed", {
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

/**
 * The Stream of a watch: its first element from the handle's value, each value call's from `element`. The listener
 * Chord calls returns once the consumer took the element before (the stream's buffer holds one), so Chord folds what
 * changes until then; the watch is stopped when the stream's scope closes.
 */
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
				const services = yield* Effect.context<never>();
				const run = Effect.runPromiseWith(services);
				// Built once per watch; a call only runs it. An offer cut off because the stream's scope closed is dropped.
				const onCall = Match.type<WatchCall<T> | NativeWatchCall<T>>().pipe(
					Match.discriminatorsExhaustive("kind")({
						// The matched union holds both kinds' value calls; Chord gives this watch's only, `C`'s.
						value: (call) =>
							Effect.asVoid(
								Effect.exit(Queue.offer(queue, element(call as Extract<C, { readonly kind: "value" }>))),
							),
						failed: (call) => Effect.asVoid(Queue.failCause(queue, failure(call.error))),
					}),
				);
				watch.start((call) => run(onCall(call)));
				yield* Effect.forkScoped(
					Effect.flatMap(
						Effect.promise(() => watch.closed),
						(end) => Effect.asVoid(finish(queue, end)),
					),
				);
			}),
		{ bufferSize: 1, strategy: "suspend" },
	);
}

/** Ends `queue` as the watch ended: a failure fails it, any other end ends it. */
function finish<A>(queue: Queue.Queue<A, WatchError | Cause.Done>, end: WatchEnd): Effect.Effect<boolean> {
	return Match.value(end).pipe(
		Match.discriminatorsExhaustive("kind")({
			listener_error: ({ error }) => Queue.failCause(queue, failure(error)),
			failed: ({ error }) => Queue.failCause(queue, failure(error)),
			stopped: () => Queue.end(queue),
			aborted: () => Queue.end(queue),
			ended: () => Queue.end(queue),
		}),
	);
}

/** The cause a watch failure fails its Stream with. */
function failure(error: unknown): Cause.Cause<WatchFailed> {
	return Cause.fail(WatchFailed.make({ cause: error }));
}
