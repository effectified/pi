// The delivery of outcome events on the open harness: what a thread's courier does at each wake, what wakes it, and
// what an earlier process left undelivered.

import type { Shares } from "@effectified/pi-budget";
import type { ConversationId, EntryId } from "@effectified/pi-durable";
import {
	type Conversation,
	type Doc,
	type DurableError,
	Harness,
	Submission,
	Task,
	type Tx,
} from "@effectified/pi-durable";
import { Recorder } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import { Clock, Deferred, Duration, Effect, Layer, Option, Pull, Queue, Schedule, Schema, Stream } from "effect";
import * as Counts from "./counts.ts";
import type { ThreadNotFound } from "./errors.ts";
import type * as Forks from "./forks.ts";
import * as Courier from "./outcome-courier.ts";
import * as Cursor from "./outcome-cursor.ts";
import { idOf, type Mark, OutcomeEvent } from "./outcome-event.ts";
import { OutcomeSink, type OutcomeSinkError } from "./outcome-sink.ts";
import * as Standing from "./standing.ts";
import * as StorageFork from "./storage-fork.ts";
import * as Thread from "./thread.ts";

/**
 * What one attempt to deliver fails with: the sink, the record sink whose flush comes first, or a read or a commit of
 * the harness.
 */
export type Failure = OutcomeSinkError | Recorder.Failure | Counts.Failure | Cursor.Failure | ThreadNotFound;

/** Options of `layer`. */
export interface Options {
	/**
	 * How a failed attempt is tried again: its input is what the attempt failed with. The schedule is asked for the
	 * delay after the nth failure in a row, and the wait is a durable sleep of the thread's courier, so it holds no
	 * process and outlives one. Default: forever, 100 milliseconds apart at first, doubling up to 30 seconds. When a
	 * schedule ends, the event stays undelivered until the thread's next change, or until the harness opens again.
	 */
	readonly retry?: Schedule.Schedule<unknown, Failure>;
}

const DEFAULT_RETRY: Schedule.Schedule<unknown, Failure> = Schedule.min([
	Schedule.exponential("100 millis"),
	Schedule.spaced("30 seconds"),
]);

/** Threads the pump looks at at once. */
const CONCURRENT_THREADS = 16;

/** What the delivery runs on: the open harness, the money of a thread, the recorder's pump, and the product's sink. */
type Composed = Harness.Harness | Shares | Forks.Accounts | Recorder.Recorder | OutcomeSink;

/**
 * Starts the delivery of outcome events for the scope, on the open harness.
 *
 * - **The courier.** Every thread has a courier, a durable task (`OutcomeCourier.task`). At each wake it delivers
 *   what is due for its thread, one event at a time: the event is stored first (`thread.outcomes`, `pending`), then
 *   the records of everything the harness committed are flushed to the record sink, then the outcome sink is called,
 *   and only then the cursor moves. So an event is delivered at least once, after the transcript it rests on, and a
 *   repeat has the id and the content of the first.
 * - **A failed attempt** puts the courier to sleep until the time `options.retry` gives. A delivery is therefore
 *   work of the harness itself: while a courier runs, Pi has work that can run, and while it sleeps until a time, Pi
 *   has a sleep that is due then, which is what a host holds its process awake for and wakes it up for. The thread's
 *   own run never waits for a courier.
 * - **What wakes a courier.** This Layer observes Pi's stored commits: a submission of a thread that was admitted or
 *   settled, and a verdict of its review, queue the thread, and a thread with something due has its courier woken
 *   (or started, when Pi ended the last one), unless the courier sleeps until its next attempt.
 * - **Recovery.** Building the Layer looks at every thread of the storage, so what an earlier process reached and
 *   did not deliver is delivered now, also by a courier that was asleep until a later attempt. The Layer does not
 *   wait for those deliveries.
 *
 * Which states are events: `Started` for each submission of a thread, then every wait of its review the transcript
 * holds (each hold and each deferral, from its verdict), then how the submission ended once it settled. They are read
 * from what the harness stored, not from where the thread stands when its courier looks, so a hold a person released
 * at once is told, and so is the end of a run the product took on before it was told.
 */
export function layer(options: Options = {}): Layer.Layer<never, DurableError, Composed | Courier.Delivery> {
	return Layer.effectDiscard(
		Effect.gen(function* () {
			const composed = yield* Effect.context<Composed>();
			const harness = yield* Harness.Harness;
			const retry = options.retry ?? DEFAULT_RETRY;
			yield* Deferred.succeed(yield* Courier.Delivery, (task, api) =>
				Effect.provide(deliver(retry, task, api), composed),
			);

			const threads = new Map<ConversationId, string>();
			/** Threads that wait in `queue` for a look that has not started. */
			const queued = new Set<string>();
			const queue = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
			/** Called by Pi inside its publication of a commit, so it only notes the thread. */
			const notice = (thread: string): void => {
				if (queued.has(thread)) return;
				queued.add(thread);
				Queue.offerUnsafe(queue, thread);
			};
			const known = (conversation: ConversationId, input: unknown): void => {
				// Stored input: a courier's own, as Pi kept it.
				const courier = decodeInput(input);
				if (Option.isSome(courier)) threads.set(conversation, courier.value.thread);
			};

			// Attached before the storage is read, so no commit falls between the two.
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					harness.observeCommits({
						advance: (publication) => {
							// A change's order in a commit is not specified: the threads the commit creates first.
							for (const change of publication.changes) {
								if (change.type === "task" && change.value.kind === Courier.task.name) {
									known(change.value.conversationId, change.value.input);
								}
							}
							for (const change of publication.changes) {
								const moved =
									change.type === "submission" ||
									(change.type === "entry" && change.value.kind === Review.VerdictEntry.kind);
								const thread = moved ? threads.get(change.value.conversationId) : undefined;
								if (thread !== undefined) notice(thread);
							}
						},
						end: () => {},
					}),
				),
				(observation) => Effect.sync(() => observation.detach()),
			);
			yield* Stream.runForEach(Harness.scanTasks({ kind: Courier.task.name }), (courier) =>
				Effect.sync(() => known(courier.conversationId, courier.input)),
			).pipe(Effect.provide(composed));
			const watched = <E extends { readonly _tag: string }>(
				thread: string,
				look: Effect.Effect<void, E, Composed>,
			) =>
				look.pipe(
					// Never the error's message: Pi's may quote content.
					Effect.catch((error) =>
						Effect.annotateLogs(
							Effect.logWarning("A thread's outcome could not be looked at; its next change tries again"),
							{ thread, error: error._tag },
						),
					),
					Effect.provide(composed),
				);
			// What an earlier process left: every thread of the storage, once.
			yield* Effect.forkScoped(
				Effect.forEach(new Set(threads.values()), (thread) => watched(thread, reopened(thread)), {
					concurrency: CONCURRENT_THREADS,
					discard: true,
				}),
			);
			yield* Effect.forkScoped(
				Stream.fromQueue(queue).pipe(
					Stream.mapEffect(
						(thread) =>
							watched(
								thread,
								Effect.suspend(() => {
									// From here on a commit is noticed again: this look may have read before it.
									queued.delete(thread);
									return changed(thread);
								}),
							),
						{ concurrency: CONCURRENT_THREADS, unordered: true },
					),
					Stream.runDrain,
				),
			);
		}),
	);
}

const decodeInput = Schema.decodeUnknownOption(Courier.Input);

/**
 * After a change of the thread: wakes its courier when something is due for it, unless the courier sleeps until its
 * next attempt after a failed one. That time is the product's schedule, and the courier tells of the change then.
 */
function changed(thread: string): Effect.Effect<void, Cursor.Failure, Harness.Harness> {
	return looked(thread, (cursor, now) => cursor.retryAt !== null && cursor.retryAt > now);
}

/**
 * As the harness opens: wakes the thread's courier when something is due for it, also one that sleeps until a later
 * attempt. What an earlier process reached and did not deliver is offered at once.
 */
function reopened(thread: string): Effect.Effect<void, Cursor.Failure, Harness.Harness> {
	return looked(thread, () => false);
}

/**
 * Wakes the thread's courier when something is due for it and `waits` does not say that it is to be left asleep. A
 * thread whose events are all delivered costs a few reads: its cursor, its submissions, and the verdicts since the
 * cursor.
 */
function looked(
	thread: string,
	waits: (cursor: Cursor.Cursor, now: number) => boolean,
): Effect.Effect<void, Cursor.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const conversation = yield* Thread.conversation(thread);
		const cursor = yield* cursorOf(thread);
		if (waits(cursor, yield* Clock.currentTimeMillis)) return;
		const due = cursor.pending !== null || (yield* dueOf(thread, conversation, cursor.delivered))._tag !== "Nothing";
		if (due) yield* Harness.commit((tx) => Cursor.wakeIn(tx, thread, conversation.id));
	}).pipe(
		// A courier of a thread this storage does not hold: a document Pi lost. Nothing can be delivered for it.
		Effect.catchTag("ThreadNotFound", () => Effect.void),
	);
}

/** The cursor of `thread` now: as a new thread's for one that has none. */
function cursorOf(thread: string): Effect.Effect<Cursor.Cursor, Doc.Failure, Harness.Harness> {
	return Effect.map(
		Harness.snapshot(Cursor.Document, thread),
		Option.getOrElse((): Cursor.Cursor => Cursor.Document.initial(null)),
	);
}

/**
 * What a courier does at one wake: delivers what is due for its thread, then ends, when the thread's newest
 * submission settled, or sleeps until it is woken. A failed attempt ends in a sleep until the next one. A courier
 * that was copied with its storage ends at once: its thread's events are its source's to deliver.
 */
function deliver(
	retry: Schedule.Schedule<unknown, Failure>,
	task: Courier.Running,
	api: Courier.Api,
): Effect.Effect<Courier.Step, never, Composed> {
	const { thread } = task.input;
	const attempt = (stamp: number): Effect.Effect<Courier.Step, Failure, Composed> =>
		Effect.gen(function* () {
			const conversation = yield* Thread.conversation(thread);
			const over = yield* drain(thread, conversation);
			return yield* api.commit((tx) => rested(tx, task, stamp, over));
		});
	return Effect.gen(function* () {
		if ((yield* StorageFork.inherited)(task.id)) return Task.aborted("copied");
		// Before the first look: a wake that comes from here on is seen when the step is stored.
		const { stamp } = yield* cursorOf(thread);
		return yield* Effect.catch(attempt(stamp), (error) =>
			Effect.andThen(
				// Never the error's message: a sink's or Pi's may quote content.
				Effect.annotateLogs(Effect.logWarning("A thread's outcome could not be delivered; it is tried again"), {
					thread,
					error: error._tag,
				}),
				postponed(retry, task, api, error, stamp),
			),
		);
	}).pipe(
		// A step Pi refuses leaves nothing to return: Pi ends the task, and the next look at the thread starts one.
		Effect.orDie,
	);
}

/**
 * The courier's step once nothing is due, stored with what it says in the cursor: it looks again when a wake came
 * since `stamp` was read, ends when the thread's work is over, and otherwise sleeps on a key the cursor names.
 */
function rested(
	tx: Tx.Tx,
	task: Courier.Running,
	stamp: number,
	over: boolean,
): Effect.Effect<Task.Step<typeof Courier.State.Type, null>, Cursor.Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Cursor.Document, task.input.thread, null);
		const held = yield* document.get;
		const next = { phase: "deliver" as const, turn: task.state.turn + 1, failures: 0 };
		if (held.stamp !== stamp) return Task.next(next);
		if (over) {
			yield* document.set({ ...held, courier: null, waiting: null, retryAt: null });
			return Task.complete(null);
		}
		const key = Courier.key(task.state.turn);
		yield* document.set({ ...held, waiting: key, retryAt: null });
		return Task.sleep({ state: next, signals: [Courier.Nudge.key(key)] });
	});
}

/**
 * The courier's step after a failed attempt: a sleep until the time the schedule gives for this failure, which a
 * wake cuts short, as the reopening of the harness does. When the schedule has ended it sleeps until it is woken,
 * unless a wake came since `stamp` was read: then it tries at once, since nothing would wake it again.
 */
function postponed(
	retry: Schedule.Schedule<unknown, Failure>,
	task: Courier.Running,
	api: Courier.Api,
	error: Failure,
	stamp: number,
): Effect.Effect<Courier.Step, Cursor.Failure> {
	return Effect.gen(function* () {
		const now = yield* api.now;
		const delay = yield* delayAfter(retry, task.state.failures, error, now);
		const key = Courier.key(task.state.turn);
		const turn = task.state.turn + 1;
		return yield* api.commit((tx) =>
			Effect.gen(function* () {
				const document = yield* tx.doc(Cursor.Document, task.input.thread, null);
				const held = yield* document.get;
				const rested = { phase: "deliver" as const, turn, failures: 0 };
				if (Option.isNone(delay) && held.stamp !== stamp) return Task.next(rested);
				const until = Option.map(delay, (wait) => now + Duration.toMillis(wait));
				yield* document.set({ ...held, waiting: key, retryAt: Option.getOrNull(until) });
				const signals = [Courier.Nudge.key(key)];
				return Option.match(until, {
					onNone: () => Task.sleep({ state: rested, signals }),
					onSome: (at) =>
						Task.sleep({ state: { ...rested, failures: task.state.failures + 1 }, until: at, signals }),
				});
			}),
		);
	});
}

/**
 * The delay `schedule` gives after `failures` failures in a row and one more: the schedule is stepped that often from
 * its start, on a clock that moves by its own delays, because the failures before this one were in other invocations
 * of the task, and maybe in other processes. None once the schedule has ended.
 */
function delayAfter(
	schedule: Schedule.Schedule<unknown, Failure>,
	failures: number,
	error: Failure,
	now: number,
): Effect.Effect<Option.Option<Duration.Duration>> {
	return Effect.gen(function* () {
		const step = yield* Schedule.toStep(schedule);
		let at = now;
		let delay = Option.none<Duration.Duration>();
		for (let failure = 0; failure <= failures; failure += 1) {
			delay = yield* Pull.catchDone(
				Effect.map(step(at, error), ([, wait]) => Option.some(wait)),
				() => Effect.succeedNone,
			);
			if (Option.isNone(delay)) return delay;
			at += Duration.toMillis(delay.value);
		}
		return delay;
	});
}

/**
 * Delivers everything that is due for the thread, oldest first, and says whether its work is over: its newest
 * submission settled, so nothing more comes by it. Per event: the event is stored as pending, the records are
 * flushed, the sink is called, and the cursor moves. An event an earlier attempt stored is delivered as stored.
 */
function drain(thread: string, conversation: Conversation.Conversation): Effect.Effect<boolean, Failure, Composed> {
	return Effect.gen(function* () {
		while (true) {
			const cursor = yield* cursorOf(thread);
			if (cursor.pending !== null) {
				const { mark, event } = cursor.pending;
				yield* Option.match(decodeEvent(event), {
					// An event another version stored: it is worked out again from where the thread stands.
					onNone: () => noted(thread, (held) => ({ ...held, pending: null })),
					onSome: (stored) => sent(thread, stored, mark),
				});
				continue;
			}
			const due = yield* dueOf(thread, conversation, cursor.delivered);
			if (due._tag === "Nothing") return due.over;
			const planned = yield* planOf(thread, conversation, due);
			const pending = { mark: planned.mark, event: yield* Effect.orDie(encodeEvent(planned.event)) };
			yield* noted(thread, (held) => ({ ...held, pending }));
			yield* sent(thread, planned.event, planned.mark);
		}
	});
}

const codec = Schema.toCodecJson(OutcomeEvent);

const encodeEvent = Schema.encodeEffect(codec);

// Stored input: an event another version stored may not decode.
const decodeEvent = Schema.decodeUnknownOption(codec);

/** Changes the thread's cursor, in a commit of its own. */
function noted(
	thread: string,
	change: (held: Cursor.Cursor) => Cursor.Cursor,
): Effect.Effect<void, Doc.Failure, Harness.Harness> {
	return Harness.commit((tx) =>
		Effect.flatMap(tx.doc(Cursor.Document, thread, null), (document) => document.update(change)),
	);
}

/**
 * One delivery: the records of everything the harness committed so far go to the record sink first, then the event
 * to the outcome sink, and then the cursor moves to `mark`.
 */
function sent(thread: string, event: OutcomeEvent, mark: Mark): Effect.Effect<void, Failure, Composed> {
	return Effect.gen(function* () {
		yield* Recorder.flushAll;
		yield* OutcomeSink.use((sink) => sink.deliver(event));
		yield* noted(thread, (held) => ({ ...held, delivered: mark, pending: null }));
	});
}

/**
 * What is due for a thread: nothing, the start of a submission, or an outcome of one. An outcome is a wait of its
 * review, which rests on the verdict that began it (`rests`), or where the thread stands, which rests on the newest
 * entry.
 */
type Due =
	| { readonly _tag: "Nothing"; readonly over: boolean }
	| { readonly _tag: "Started"; readonly submission: Thread.Newest }
	| {
			readonly _tag: "Reached";
			readonly submission: Thread.Newest;
			readonly ending: Standing.Ending;
			readonly rests: Option.Option<EntryId>;
			readonly settled: boolean;
	  };

/**
 * What is due for the thread after the event `delivered`, in the order the thread went: the start of a submission,
 * then every wait of its review the transcript holds (a hold, a deferral), then how it ended once it settled, then
 * the start of the next one. The waits are read from the verdicts, so a hold a person released before the courier
 * looked is still told, and so is the end of a submission the product took on at once. A settled submission whose
 * end was told costs no read of the transcript, but one page for an end that is a budget stop.
 */
function dueOf(
	thread: string,
	conversation: Conversation.Conversation,
	delivered: Mark | null,
): Effect.Effect<Due, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const all = yield* Thread.submissions(conversation.id, thread);
		const at = delivered === null ? -1 : all.findIndex((one) => one.record.id === delivered.submission);
		const current = all[at];
		// Nothing told yet starts at the first submission. A cursor on a submission the thread does not hold, which no
		// version writes, starts at the newest.
		if (delivered === null || current === undefined) {
			const first = delivered === null ? all[0] : all.at(-1);
			return first === undefined ? { _tag: "Nothing", over: false } : { _tag: "Started", submission: first };
		}
		const next = all[at + 1];
		const after: Due = next === undefined ? { _tag: "Nothing", over: true } : { _tag: "Started", submission: next };
		const settled = Submission.settled(current.record.status);
		const ending = settled ? yield* Standing.endingOf(current.record, conversation) : Option.none<Standing.Ending>();
		if (Option.isSome(ending) && (yield* told(conversation, delivered, ending.value))) return after;
		const wait = yield* waitAfter(conversation, current, boundOf(all, at), delivered.entry);
		if (Option.isSome(wait)) {
			const reached = yield* Standing.waited(wait.value.wait);
			return {
				_tag: "Reached",
				submission: current,
				ending: reached,
				rests: Option.some(wait.value.entry),
				settled: false,
			};
		}
		if (Option.isSome(ending)) {
			return { _tag: "Reached", submission: current, ending: ending.value, rests: Option.none(), settled: true };
		}
		// An open submission after a newer one is no state Pi makes: what is due is the newer one's.
		if (next !== undefined) return after;
		return yield* storedBefore(conversation, current, delivered);
	});
}

/**
 * Whether `delivered` is the event of `ending`, the end of its settled submission. A wait of the same tag, a deferral
 * the budget refused (`BudgetStopped`), rests on its verdict: the end is told after it.
 */
function told(
	conversation: Conversation.Conversation,
	delivered: Mark,
	ending: Standing.Ending,
): Effect.Effect<boolean, Doc.Failure, Harness.Harness> {
	if (delivered.state !== ending._tag) return Effect.succeed(false);
	if (ending._tag !== "BudgetStopped") return Effect.succeed(true);
	return Effect.map(
		Stream.runHead(Review.verdicts(conversation, { from: entryId(delivered.entry) })),
		(found) =>
			!Option.exists(found, (verdict) => verdict.id === delivered.entry && verdict.data.outcome._tag === "Deferred"),
	);
}

/**
 * The first wait of `submission`'s review stored after the entry `after`, with the entry of its verdict: a verdict
 * that held the answer or deferred the review, and names the submission among its inputs. Read from `bound` on, the
 * input entry of the submission or of the newest one before it that has one: a verdict before it is about an older
 * run.
 */
function waitAfter(
	conversation: Conversation.Conversation,
	submission: Thread.Newest,
	bound: number,
	after: number,
): Effect.Effect<Option.Option<{ readonly entry: EntryId; readonly wait: Review.Wait }>, Review.Failure> {
	return Review.verdicts(conversation, { from: entryId(Math.max(bound, after + 1)) }).pipe(
		Stream.map((verdict) =>
			verdict.data.inputs?.includes(submission.record.id) === true
				? Option.map(Review.waitOf(verdict.data), (wait) => ({ entry: verdict.id, wait }))
				: Option.none(),
		),
		Stream.filter(Option.isSome),
		Stream.map((found) => found.value),
		Stream.runHead,
	);
}

/** Where the entries of the submission at `at` begin: its input entry, or the one of the newest before it; 0 for none. */
function boundOf(all: ReadonlyArray<Thread.Newest>, at: number): number {
	for (let index = at; index >= 0; index -= 1) {
		const entry = all[index]?.record.entry;
		if (entry !== undefined) return entry;
	}
	return 0;
}

/**
 * The bound of a read of entries from `entry`: a mark's entry, 0 for none, or one after it. Pi brands an entry id in
 * the type system only, and a bound is a number of the same kind: at run time the two are the same.
 */
function entryId(entry: number): EntryId {
	return entry as EntryId;
}

/**
 * What is due for an open submission whose review waits on a verdict stored before verdicts named their inputs: the
 * wait where the thread stands, as the courier read it before, due again when it rests on a newer entry. So a thread
 * in flight across the upgrade is told of the wait it is in; one it left before the courier looked is passed over.
 */
function storedBefore(
	conversation: Conversation.Conversation,
	submission: Thread.Newest,
	delivered: Mark,
): Effect.Effect<Due, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const nothing: Due = { _tag: "Nothing", over: false };
		const ending = yield* Standing.endingOf(submission.record, conversation);
		if (Option.isNone(ending)) return nothing;
		// A wait whose verdict names its inputs was looked for in the transcript already.
		const verdict = verdictOf(ending.value);
		if (verdict === undefined || verdict.inputs !== undefined) return nothing;
		if (delivered.state === ending.value._tag && delivered.entry === (yield* headOf(conversation))) return nothing;
		return { _tag: "Reached", submission, ending: ending.value, rests: Option.none(), settled: false };
	});
}

/**
 * The verdict a wait rests on: what an open submission ends with is a wait (`Held`, `ReviewDeferred`, or
 * `BudgetStopped` with the deferred verdict). None for any other ending.
 */
function verdictOf(ending: Standing.Ending): Review.Verdict | undefined {
	switch (ending._tag) {
		case "Held":
		case "ReviewDeferred":
			return ending.verdict;
		case "BudgetStopped":
			return ending.review;
		case "Reviewed":
		case "Answered":
		case "NotReviewed":
		case "Errored":
		case "Cancelled":
			return undefined;
	}
}

/** The id of the conversation's newest entry, 0 for none. */
function headOf(conversation: Conversation.Conversation): Effect.Effect<number, DurableError> {
	return Effect.map(
		conversation.head,
		Option.getOrElse(() => 0),
	);
}

/**
 * How long an outcome of a settled submission waits for its conversation to be idle before it is read: the tasks a
 * run asks for at its end (`afterRun`) end after the submission settled, and the counts are then what the thread
 * took by them. Work that came after the run, such as a swarm started on the thread, is not waited for.
 */
const IDLE_GRACE_MILLIS = 250;

/**
 * The event that is due, and its mark. An outcome of a settled submission waits `IDLE_GRACE_MILLIS` at most. A wait
 * rests on its verdict, any other outcome on the newest entry.
 */
function planOf(
	thread: string,
	conversation: Conversation.Conversation,
	due: Exclude<Due, { readonly _tag: "Nothing" }>,
): Effect.Effect<{ readonly event: OutcomeEvent; readonly mark: Mark }, Failure, Composed> {
	return Effect.gen(function* () {
		const { key, attempt, record } = due.submission;
		const about = { thread, key, attempt };
		switch (due._tag) {
			case "Started": {
				const mark: Mark = { submission: record.id, entry: 0, state: "Started" };
				return { mark, event: { _tag: "Started", id: idOf(thread, mark), ...about } };
			}
			case "Reached": {
				if (due.settled) yield* Effect.timeoutOption(conversation.waitForIdle, IDLE_GRACE_MILLIS);
				const entry = Option.isSome(due.rests) ? due.rests.value : yield* headOf(conversation);
				const mark: Mark = { submission: record.id, entry, state: due.ending._tag };
				const outcome = yield* Counts.counted(thread, conversation, due.ending);
				return { mark, event: { _tag: "Reached", id: idOf(thread, mark), ...about, outcome } };
			}
		}
	});
}
