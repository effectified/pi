// Pi Durable's watches and observers as Streams: the state at attachment, then its changes, released with the scope.

import type {
	CommitObservation,
	CommitObserver,
	CommitPublication,
	Observation,
	Observer,
	WatchCall,
	WatchEnd,
	WatchHandle,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import { Cause, Effect, Queue, Stream } from "effect";
import { absurd } from "effect/Function";
import { call } from "./call.ts";
import { type DurableError, fromRejection } from "./errors.ts";

/**
 * One element of a watch: Chord's value call without its tag. The newest committed value and the Chord operations
 * that turn the value of the element before into it; the first element is the value at attachment, without
 * operations. `retired` says the watched document was retired since the element before; the value is then the last
 * one it had.
 */
export type Change<T> = StrictOmit<Extract<WatchCall<T>, { readonly kind: "value" }>, "kind">;

/**
 * A Pi watch as a Stream. Pi delivers one change at a time and folds the commits that land meanwhile into the next
 * one, so a slow consumer gets fewer, larger changes and always the newest value: it converges, it is not a log of
 * every commit. The stream ends when what it watches ends (the harness closed, a task document's task ended) or when
 * `acquire` found nothing to watch, in which case it has no element; it fails when the harness failed, and when Pi
 * delivers a `failed` call (the value cannot be computed now), which Pi Durable 1.6 never does. Closing the stream's
 * scope stops the watch. `parent` as for `call`.
 */
export function stream<T>(
	acquire: (context: ChordContext) => Promise<WatchHandle<T> | undefined>,
	parent?: ChordContext,
): Stream.Stream<Change<T>, DurableError> {
	return Stream.callback<Change<T>, DurableError>(
		(queue) =>
			Effect.gen(function* () {
				const watch = yield* Effect.acquireRelease(call(acquire, parent), (acquired) =>
					Effect.promise(async () => {
						await acquired?.stop();
					}),
				);
				if (watch === undefined) return yield* Queue.end(queue);
				yield* Queue.offer(queue, { value: watch.value, ops: [], retired: false });
				// The listener returns when the consumer took the change before: Pi folds what lands until then. It never
				// rejects: an offer cut off because the stream's scope closed is dropped.
				watch.start(async (delivered) => {
					switch (delivered.kind) {
						case "value":
							await Effect.runPromiseExit(Queue.offer(queue, change(delivered)));
							return;
						case "failed":
							fail(queue, delivered.error);
							return;
						default:
							absurd(delivered);
					}
				});
				void watch.closed.then((end) => finish(queue, end));
			}),
		{ bufferSize: 1, strategy: "suspend" },
	);
}

/**
 * A Pi observer as a Stream: every commit that changes the observed state is one element, unfolded, in commit order,
 * however slow the consumer is (they wait in memory). Otherwise as `stream`, a `failed` call included; a closed scope
 * detaches the observer.
 */
export function observed<T>(
	attach: (observer: Observer<T>, context: ChordContext) => Promise<Observation<T> | undefined>,
	parent?: ChordContext,
): Stream.Stream<Change<T>, DurableError> {
	return Stream.callback<Change<T>, DurableError>((queue) =>
		Effect.gen(function* () {
			// Pi may deliver a change before the attachment resolves: it waits here until the first element is in.
			const early: Array<Change<T>> = [];
			let attached = false;
			const observer: Observer<T> = {
				// Called inside Pi's commit: it only records.
				advance: (delivered) => {
					switch (delivered.kind) {
						case "value":
							if (attached) Queue.offerUnsafe(queue, change(delivered));
							else early.push(change(delivered));
							return;
						case "failed":
							fail(queue, delivered.error);
							return;
						default:
							absurd(delivered);
					}
				},
				end: (end) => finish(queue, end),
			};
			const observation = yield* Effect.acquireRelease(
				call((context) => attach(observer, context), parent),
				(acquired) => Effect.sync(() => acquired?.detach()),
			);
			if (observation === undefined) return yield* Queue.end(queue);
			Queue.offerUnsafe(queue, { value: observation.value, ops: [], retired: false });
			for (const missed of early) Queue.offerUnsafe(queue, missed);
			attached = true;
		}),
	);
}

/**
 * One stored commit as Pi publishes it to a commit observer: its sequence number in storage and every change that
 * storage transaction stored, in no particular order. A table change is the whole record written (`conversation`,
 * `entry`, `task`, `submission`); a document change is its record with the new value and the operations that led to
 * it (`document`, kind `change`), its retirement (kind `retire`), or its copy into a fork (`document.copy`).
 */
export interface Commit extends CommitPublication {}

/**
 * Pi's commit observer (`observeCommits`) as a Stream: one element per storage transaction from the moment the stream
 * runs, in commit order, each with exactly what was stored. Nothing for a commit that wrote nothing, and nothing for a
 * deferred commit until it is stored, with the commit or the deadline that stores it. A commit stored before the
 * stream ran is not an element: it is a log from now on, not a state.
 *
 * Pi calls the observer on its line of commits, so it only records: elements wait in memory until the consumer takes
 * them, without a bound, and a slow consumer never holds a commit up. A waiting element holds the records Pi stored,
 * not copies. The stream fails with `UnexpectedError` ("session closed") when the harness closes, as Pi ends its
 * observers, and with the harness's own failure when it failed. Closing the stream's scope detaches the observer.
 */
export function commits(attach: (observer: CommitObserver) => CommitObservation): Stream.Stream<Commit, DurableError> {
	return Stream.callback<Commit, DurableError>((queue) =>
		Effect.acquireRelease(
			// Pi attaches at once, and throws for a harness that has closed.
			Effect.try({
				try: () =>
					attach({
						advance: (publication) => void Queue.offerUnsafe(queue, publication),
						end: (end) => finish(queue, end),
					}),
				catch: fromRejection,
			}),
			(observation) => Effect.sync(() => observation.detach()),
		),
	);
}

/** One value call of Pi as an element: every field but the tag, so a field Chord adds reaches the stream. */
function change<T>(delivered: Extract<WatchCall<T>, { readonly kind: "value" }>): Change<T> {
	const { kind: _kind, ...element } = delivered;
	return element;
}

/**
 * Fails the stream of a watch with what Pi gave as the error. A `failed` call fails it too: Chord would keep the watch
 * open and send the value again later, but a stream element has no failure to carry, and dropping it would leave the
 * consumer on a value Pi said it cannot compute.
 */
function fail<A>(queue: Queue.Queue<A, DurableError | Cause.Done>, error: unknown): void {
	Queue.failCauseUnsafe(queue, Cause.fail(fromRejection(error)));
}

/** Ends the stream of a watch as the watch ended. */
function finish<A>(queue: Queue.Queue<A, DurableError | Cause.Done>, end: WatchEnd): void {
	switch (end.kind) {
		case "stopped":
		case "aborted":
		case "ended":
			Queue.endUnsafe(queue);
			return;
		case "listener_error":
		case "failed":
			fail(queue, end.error);
			return;
		default:
			// A kind of end Chord adds fails to compile here, so no watch stream can be left open by one.
			absurd(end);
	}
}
