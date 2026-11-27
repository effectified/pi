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
import { Cause, Effect, Match, Queue, type Scope, Stream } from "effect";
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
 * delivers a `failed` call (the value cannot be computed now), which Pi Durable 1.6 never does. Interruption goes both
 * ways: closing the stream's scope stops Pi's watch, and Pi's end of the watch ends the stream. `parent` as for `call`.
 */
export function stream<T>(
	acquire: (context: ChordContext) => Promise<WatchHandle<T> | undefined>,
	parent?: ChordContext,
): Stream.Stream<Change<T>, DurableError> {
	return Stream.callback<Change<T>, DurableError>(
		(queue) =>
			Effect.gen(function* () {
				const watch = yield* Effect.acquireRelease(call(acquire, parent), (acquired) =>
					acquired === undefined ? Effect.void : Effect.promise(() => acquired.stop()),
				);
				if (watch === undefined) return yield* Queue.end(queue);
				yield* Queue.offer(queue, { value: watch.value, ops: [], retired: false });
				const services = yield* Effect.context<never>();
				const run = Effect.runPromiseWith(services);
				// Built once per watch; a delivery only runs it. The listener returns once the consumer took the change before
				// (the buffer holds one), so Pi folds what lands until then. It never rejects: an offer cut off because the
				// stream's scope closed is dropped.
				const deliver = Match.type<WatchCall<T>>().pipe(
					Match.discriminatorsExhaustive("kind")({
						value: (delivered) => Effect.asVoid(Effect.exit(Queue.offer(queue, change(delivered)))),
						failed: (delivered) => Effect.asVoid(Queue.failCause(queue, failure(delivered.error))),
					}),
				);
				watch.start((delivered) => run(deliver(delivered)));
				yield* Effect.forkScoped(
					Effect.flatMap(
						Effect.promise(() => watch.closed),
						(end) => finish(queue, end),
					),
				);
			}),
		{ bufferSize: 1, strategy: "suspend" },
	);
}

/**
 * A Pi observer as a Stream: every commit that changes the observed state is one element, unfolded, in commit order,
 * however slow the consumer is (they wait in memory). Otherwise as `stream`, a `failed` call included; a closed scope
 * detaches the observer, and Pi's end of the observer ends the stream.
 */
export function observed<T>(
	attach: (observer: Observer<T>, context: ChordContext) => Promise<Observation<T> | undefined>,
	parent?: ChordContext,
): Stream.Stream<Change<T>, DurableError> {
	return Stream.callback<Change<T>, DurableError>((queue) =>
		Effect.gen(function* () {
			const services = yield* Effect.context<never>();
			const run = Effect.runSyncWith(services);
			// Pi may deliver a change before the attachment resolves: it waits here until the first element is in.
			const early: Array<Change<T>> = [];
			let attached = false;
			// Called inside Pi's commit, so it only records; built once per observer, a commit only runs it.
			const advance = Match.type<WatchCall<T>>().pipe(
				Match.discriminatorsExhaustive("kind")({
					value: (delivered) => {
						if (attached) Queue.offerUnsafe(queue, change(delivered));
						else early.push(change(delivered));
					},
					failed: (delivered) => {
						run(Queue.failCause(queue, failure(delivered.error)));
					},
				}),
			);
			const observer: Observer<T> = { advance, end: (end) => void run(finish(queue, end)) };
			const observation = yield* Effect.acquireRelease(
				call((context) => attach(observer, context), parent),
				(acquired) => Effect.sync(() => acquired?.detach()),
			);
			if (observation === undefined) return yield* Queue.end(queue);
			Queue.offerAllUnsafe(queue, [{ value: observation.value, ops: [], retired: false }, ...early]);
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
	return Stream.unwrap(attachCommits(attach));
}

/**
 * Pi's commit observer attached now, for the scope, and its commits as a Stream, as `commits` gives them: for a caller
 * that must know when the observer is attached, such as one that reads a state once and then follows what changes it,
 * and must miss no commit stored while it reads. Every commit stored after the Effect succeeded is an element. The
 * Effect fails when Pi refuses the attachment, as a closed harness does. The stream is the one observer: run it once.
 */
// Untraced: the observer runs Effects later, on the context taken here, which a span of this call would outlive.
export const attachCommits = Effect.fnUntraced(function* (
	attach: (observer: CommitObserver) => CommitObservation,
): Effect.fn.Return<Stream.Stream<Commit, DurableError>, DurableError, Scope.Scope> {
	const queue = yield* Effect.acquireRelease(Queue.unbounded<Commit, DurableError | Cause.Done>(), Queue.shutdown);
	const services = yield* Effect.context<never>();
	const run = Effect.runSyncWith(services);
	yield* Effect.acquireRelease(
		// Pi attaches at once, and throws for a harness that has closed.
		Effect.try({
			try: () =>
				attach({
					advance: (publication) => void Queue.offerUnsafe(queue, publication),
					end: (end) => void run(finish(queue, end)),
				}),
			catch: fromRejection,
		}),
		(observation) => Effect.sync(() => observation.detach()),
	);
	return Stream.fromQueue(queue);
});

/** One value call of Pi as an element: every field but the tag, so a field Chord adds reaches the stream. */
function change<T>(delivered: Extract<WatchCall<T>, { readonly kind: "value" }>): Change<T> {
	const { kind: _kind, ...element } = delivered;
	return element;
}

/**
 * The cause a watch's stream fails with for what Pi gave as the error. A `failed` call fails it too: Chord would keep
 * the watch open and send the value again later, but a stream element has no failure to carry, and dropping it would
 * leave the consumer on a value Pi said it cannot compute.
 */
function failure(error: unknown): Cause.Cause<DurableError> {
	return Cause.fail(fromRejection(error));
}

/**
 * Ends the stream of a watch as the watch ended: a failure fails it, any other end ends it. A kind of end Chord adds
 * fails to compile here, so no watch stream can be left open by one.
 */
function finish<A>(queue: Queue.Queue<A, DurableError | Cause.Done>, end: WatchEnd): Effect.Effect<boolean> {
	return Match.value(end).pipe(
		Match.discriminatorsExhaustive("kind")({
			stopped: () => Queue.end(queue),
			aborted: () => Queue.end(queue),
			ended: () => Queue.end(queue),
			listener_error: ({ error }) => Queue.failCause(queue, failure(error)),
			failed: ({ error }) => Queue.failCause(queue, failure(error)),
		}),
	);
}
