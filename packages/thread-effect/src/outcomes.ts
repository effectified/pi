// The delivery of outcome events on the open harness: what a thread's courier does at each wake, what wakes it, and
// what an earlier process left undelivered.

import type { Shares } from "@effectified/pi-budget";
import type { ConversationId, EntryId } from "@effectified/pi-durable";
import {
	type Conversation,
	type Doc,
	type DurableError,
	Entry,
	Harness,
	Submission,
	Task,
	type Tx,
} from "@effectified/pi-durable";
import { Recorder } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import {
	Array as Arr,
	Clock,
	Data,
	Deferred,
	Duration,
	Effect,
	Layer,
	Match,
	MutableHashMap,
	MutableHashSet,
	Option,
	Pull,
	Queue,
	Result,
	Schedule,
	Schema,
	Stream,
} from "effect";
import * as Counts from "./counts.ts";
import type { ThreadNotFound } from "./errors.ts";
import type * as Forks from "./forks.ts";
import type { ThreadKey } from "./ids.ts";
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

/** Options of `layer`. An interface, not a Schema: it holds a `Schedule`. */
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
			const retry = options.retry ?? DEFAULT_RETRY;
			const delivery = yield* Courier.Delivery;
			yield* Deferred.succeed(delivery, (task, api) => Effect.provide(deliver(retry, task, api), composed));

			/** The thread of every conversation with a courier: what a commit's changes are read by. */
			const threads = MutableHashMap.empty<ConversationId, ThreadKey>();
			/** Threads that wait in `queue` for a look that has not started. */
			const queued = MutableHashSet.empty<ThreadKey>();
			const queue = yield* Effect.acquireRelease(Queue.unbounded<ThreadKey>(), Queue.shutdown);
			const notice = (thread: ThreadKey): void => {
				if (MutableHashSet.has(queued, thread)) return;
				MutableHashSet.add(queued, thread);
				Queue.offerUnsafe(queue, thread);
			};
			const known = (conversation: ConversationId, input: unknown): void => {
				// Stored input: a courier's own, as Pi kept it.
				const courier = decodeInput(input);
				if (Option.isSome(courier)) MutableHashMap.set(threads, conversation, courier.value.thread);
			};

			// Attached before the scan below starts: a commit stored while it reads is an element of this stream.
			const commits = yield* Harness.attachCommits;
			const noticing = Stream.runForEach(commits, (publication) =>
				Effect.sync(() => {
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
						const thread = moved ? MutableHashMap.get(threads, change.value.conversationId) : Option.none();
						if (Option.isSome(thread)) notice(thread.value);
					}
				}),
			).pipe(
				// The harness closes with this scope, and its commits end with it ("session closed"): nothing is left to
				// notice then.
				Effect.ignore,
			);
			yield* Effect.forkScoped(noticing);
			yield* Stream.runForEach(Harness.scanTasks({ kind: Courier.task.name }), (courier) =>
				Effect.sync(() => known(courier.conversationId, courier.input)),
			);
			const watched = (thread: ThreadKey, look: Effect.Effect<void, Cursor.Failure, Harness.Harness>) =>
				Effect.catch(look, (error) =>
					// Never the error's message: Pi's may quote content.
					Effect.annotateLogs(
						Effect.logWarning("A thread's outcome could not be looked at; its next change tries again"),
						{
							thread,
							error: error._tag,
						},
					),
				);
			// What an earlier process left: every thread of the storage, once.
			yield* Effect.forkScoped(
				Effect.forEach(Arr.dedupe(MutableHashMap.values(threads)), (thread) => watched(thread, reopened(thread)), {
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
								// From here on a commit is noticed again: this look may have read before it.
								Effect.andThen(
									Effect.sync(() => MutableHashSet.remove(queued, thread)),
									changed(thread),
								),
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
function changed(thread: ThreadKey): Effect.Effect<void, Cursor.Failure, Harness.Harness> {
	return looked(thread, (cursor, now) => cursor.retryAt !== null && cursor.retryAt > now);
}

/**
 * As the harness opens: wakes the thread's courier when something is due for it, also one that sleeps until a later
 * attempt. What an earlier process reached and did not deliver is offered at once.
 */
function reopened(thread: ThreadKey): Effect.Effect<void, Cursor.Failure, Harness.Harness> {
	return looked(thread, () => false);
}

/**
 * Wakes the thread's courier when something is due for it and `waits` does not say that it is to be left asleep. A
 * thread whose events are all delivered costs a few reads: its cursor, its submissions, and the verdicts since the
 * cursor. A courier of a thread this storage does not hold (a document Pi lost) has nothing to deliver.
 */
const looked = Effect.fn("Outcomes.look")(
	function* (
		thread: ThreadKey,
		waits: (cursor: Cursor.Cursor, now: number) => boolean,
	): Effect.fn.Return<void, Cursor.Failure | ThreadNotFound, Harness.Harness> {
		const conversation = yield* Thread.conversation(thread);
		const cursor = yield* cursorOf(thread);
		const now = yield* Clock.currentTimeMillis;
		if (waits(cursor, now)) return;
		const due = cursor.pending !== null || (yield* dueOf(thread, conversation, cursor.delivered))._tag !== "Nothing";
		if (due) yield* Harness.commit((tx) => Cursor.wakeIn(tx, thread, conversation.id));
	},
	Effect.catchTag("ThreadNotFound", () => Effect.void),
);

/** The cursor of `thread` now: as a new thread's for one that has none. */
const cursorOf = Effect.fn("Outcomes.cursorOf")(function* (
	thread: ThreadKey,
): Effect.fn.Return<Cursor.Cursor, Doc.Failure, Harness.Harness> {
	const stored = yield* Harness.snapshot(Cursor.Document, thread);
	return Option.getOrElse(stored, (): Cursor.Cursor => Cursor.Document.initial(null));
});

/**
 * What a courier does at one wake: delivers what is due for its thread, then ends, when the thread's newest
 * submission settled, or sleeps until it is woken. A failed attempt ends in a sleep until the next one. A courier
 * that was copied with its storage ends at once: its thread's events are its source's to deliver. A step Pi refuses
 * leaves nothing to return: it is a defect, Pi ends the task, and the next look at the thread starts one.
 */
const deliver = Effect.fn("Outcomes.deliver")(function* (
	retry: Schedule.Schedule<unknown, Failure>,
	task: Courier.Running,
	api: Courier.Api,
): Effect.fn.Return<Courier.Step, Cursor.Failure, Composed> {
	const inherited = yield* StorageFork.inherited;
	if (inherited(task.id)) return Task.aborted("copied");
	// Before the first look: a wake that comes from here on is seen when the step is stored.
	const { stamp } = yield* cursorOf(task.input.thread);
	return yield* Effect.catch(attempted(task, api, stamp), (error) =>
		Effect.andThen(
			// Never the error's message: a sink's or Pi's may quote content.
			Effect.annotateLogs(Effect.logWarning("A thread's outcome could not be delivered; it is tried again"), {
				thread: task.input.thread,
				error: error._tag,
			}),
			postponed(retry, task, api, error, stamp),
		),
	);
}, Effect.orDie);

/** One attempt of a courier: everything that is due is delivered, and the step that follows is stored. */
const attempted = Effect.fn("Outcomes.attempt")(function* (
	task: Courier.Running,
	api: Courier.Api,
	stamp: number,
): Effect.fn.Return<Courier.Step, Failure, Composed> {
	const conversation = yield* Thread.conversation(task.input.thread);
	const over = yield* drain(task.input.thread, conversation);
	return yield* api.commit((tx) => rested(tx, task, stamp, over));
});

/**
 * The courier's step once nothing is due, stored with what it says in the cursor: it looks again when a wake came
 * since `stamp` was read, ends when the thread's work is over, and otherwise sleeps on a key the cursor names.
 */
const rested = Effect.fn("Outcomes.rested")(function* (
	tx: Tx.Tx,
	task: Courier.Running,
	stamp: number,
	over: boolean,
): Effect.fn.Return<Task.Step<typeof Courier.State.Type, null>, Cursor.Failure> {
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

/**
 * The courier's step after a failed attempt: a sleep until the time the schedule gives for this failure, which a
 * wake cuts short, as the reopening of the harness does. When the schedule has ended it sleeps until it is woken,
 * unless a wake came since `stamp` was read: then it tries at once, since nothing would wake it again.
 */
const postponed = Effect.fn("Outcomes.postpone")(function* (
	retry: Schedule.Schedule<unknown, Failure>,
	task: Courier.Running,
	api: Courier.Api,
	error: Failure,
	stamp: number,
): Effect.fn.Return<Courier.Step, Cursor.Failure> {
	const now = yield* api.now;
	const delay = yield* delayAfter(retry, task.state.failures, error, now);
	const key = Courier.key(task.state.turn);
	const turn = task.state.turn + 1;
	return yield* api.commit(
		Effect.fnUntraced(function* (tx) {
			const document = yield* tx.doc(Cursor.Document, task.input.thread, null);
			const held = yield* document.get;
			const rested = { phase: "deliver" as const, turn, failures: 0 };
			if (Option.isNone(delay) && held.stamp !== stamp) return Task.next(rested);
			const until = Option.map(delay, (wait) => now + Duration.toMillis(wait));
			yield* document.set({ ...held, waiting: key, retryAt: Option.getOrNull(until) });
			const signals = [Courier.Nudge.key(key)];
			return Option.match(until, {
				onNone: () => Task.sleep({ state: rested, signals }),
				onSome: (at) => Task.sleep({ state: { ...rested, failures: task.state.failures + 1 }, until: at, signals }),
			});
		}),
	);
});

/**
 * The delay `schedule` gives after `failures` failures in a row and one more: the schedule is stepped that often from
 * its start, on a clock that moves by its own delays, because the failures before this one were in other invocations
 * of the task, and maybe in other processes. None once the schedule has ended.
 */
const delayAfter = Effect.fn("Outcomes.delayAfter")(function* (
	schedule: Schedule.Schedule<unknown, Failure>,
	failures: number,
	error: Failure,
	now: number,
): Effect.fn.Return<Option.Option<Duration.Duration>> {
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

/**
 * Delivers everything that is due for the thread, oldest first, and says whether its work is over: its newest
 * submission settled, so nothing more comes by it. Per event: the event is stored as pending, the records are
 * flushed, the sink is called, and the cursor moves. An event an earlier attempt stored is delivered as stored.
 */
const drain = Effect.fn("Outcomes.drain")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
): Effect.fn.Return<boolean, Failure, Composed> {
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
		const encoded = yield* Effect.orDie(encodeEvent(planned.event));
		yield* noted(thread, (held) => ({ ...held, pending: { mark: planned.mark, event: encoded } }));
		yield* sent(thread, planned.event, planned.mark);
	}
});

const codec = Schema.toCodecJson(OutcomeEvent);

const encodeEvent = Schema.encodeEffect(codec);

// Stored input: an event another version stored may not decode.
const decodeEvent = Schema.decodeUnknownOption(codec);

/** Changes the thread's cursor, in a commit of its own. */
const noted = Effect.fn("Outcomes.note")(function* (
	thread: ThreadKey,
	change: (held: Cursor.Cursor) => Cursor.Cursor,
): Effect.fn.Return<void, Doc.Failure, Harness.Harness> {
	yield* Harness.commit((tx) =>
		Effect.flatMap(tx.doc(Cursor.Document, thread, null), (document) => document.update(change)),
	);
});

/**
 * One delivery: the records of everything the harness committed so far go to the record sink first, then the event
 * to the outcome sink, and then the cursor moves to `mark`.
 */
const sent = Effect.fn("Outcomes.send")(function* (
	thread: ThreadKey,
	event: OutcomeEvent,
	mark: Mark,
): Effect.fn.Return<void, Failure, Composed> {
	yield* Recorder.flushAll;
	const sink = yield* OutcomeSink;
	yield* sink.deliver(event);
	yield* noted(thread, (held) => ({ ...held, delivered: mark, pending: null }));
});

/**
 * What is due for a thread: nothing, the start of a submission, or an outcome of one. An outcome is a wait of its
 * review, which rests on the verdict that began it (`rests`), or where the thread stands, which rests on the newest
 * entry. Tagged data, not a Schema: it carries Pi's record of the submission.
 */
type Due = Data.TaggedEnum<{
	Nothing: { readonly over: boolean };
	Started: { readonly submission: Thread.Newest };
	Reached: {
		readonly submission: Thread.Newest;
		readonly ending: Standing.Ending;
		readonly rests: Option.Option<EntryId>;
		readonly settled: boolean;
	};
}>;

const Due = Data.taggedEnum<Due>();

/**
 * What is due for the thread after the event `delivered`, in the order the thread went: the start of a submission,
 * then every wait of its review the transcript holds (a hold, a deferral), then how it ended once it settled, then
 * the start of the next one. The waits are read from the verdicts, so a hold a person released before the courier
 * looked is still told, and so is the end of a submission the product took on at once. A settled submission whose
 * end was told costs no read of the transcript, but one page for an end that is a budget stop.
 */
const dueOf = Effect.fn("Outcomes.dueOf")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
	delivered: Mark | null,
): Effect.fn.Return<Due, Doc.Failure, Harness.Harness> {
	const all = yield* Thread.submissions(conversation.id, thread);
	const startOf = Option.match({
		onNone: () => Due.Nothing({ over: false }),
		onSome: (submission: Thread.Newest) => Due.Started({ submission }),
	});
	// Nothing told yet starts at the first submission.
	if (delivered === null) return startOf(Arr.head(all));
	const at = Arr.findFirstIndex(all, (one) => one.record.id === delivered.submission);
	// A cursor on a submission the thread does not hold, which no version writes, starts at the newest.
	if (Option.isNone(at)) return startOf(Arr.last(all));
	const current = all[at.value];
	const next = Arr.get(all, at.value + 1);
	const after = Option.match(next, {
		onNone: () => Due.Nothing({ over: true }),
		onSome: (submission) => Due.Started({ submission }),
	});
	const settled = Submission.settled(current.record.status);
	const ending = settled ? yield* Standing.endingOf(current.record, conversation) : Option.none<Standing.Ending>();
	if (Option.isSome(ending) && (yield* told(conversation, delivered, ending.value))) return after;
	const wait = yield* waitAfter(conversation, current, boundOf(all, at.value), delivered.entry);
	if (Option.isSome(wait)) {
		const reached = yield* Standing.waited(wait.value.wait);
		return Due.Reached({
			submission: current,
			ending: reached,
			rests: Option.some(wait.value.entry),
			settled: false,
		});
	}
	if (Option.isSome(ending)) {
		return Due.Reached({ submission: current, ending: ending.value, rests: Option.none(), settled: true });
	}
	// An open submission after a newer one is no state Pi makes: what is due is the newer one's.
	if (Option.isSome(next)) return after;
	return yield* storedBefore(conversation, current, delivered);
});

/**
 * Whether `delivered` is the event of `ending`, the end of its settled submission. A wait of the same tag, a deferral
 * the budget refused (`BudgetStopped`), rests on its verdict: the end is told after it.
 */
const told = Effect.fn("Outcomes.told")(function* (
	conversation: Conversation.Conversation,
	delivered: Mark,
	ending: Standing.Ending,
): Effect.fn.Return<boolean, Doc.Failure, Harness.Harness> {
	if (delivered.state !== ending._tag) return false;
	if (ending._tag !== "BudgetStopped") return true;
	const found = yield* Stream.runHead(Review.verdicts(conversation, { from: Entry.Id.make(delivered.entry) }));
	return !Option.exists(
		found,
		(verdict) => verdict.id === delivered.entry && verdict.data.outcome._tag === "Deferred",
	);
});

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
	return Review.verdicts(conversation, { from: Entry.Id.make(Math.max(bound, after + 1)) }).pipe(
		Stream.filterMap((verdict) => {
			const named = verdict.data.inputs !== undefined && Arr.contains(verdict.data.inputs, submission.record.id);
			const wait = named ? Review.waitOf(verdict.data) : Option.none();
			return Result.fromOption(
				Option.map(wait, (found) => ({ entry: verdict.id, wait: found })),
				() => verdict,
			);
		}),
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
 * What is due for an open submission whose review waits on a verdict stored before verdicts named their inputs: the
 * wait where the thread stands, as the courier read it before, due again when it rests on a newer entry. So a thread
 * in flight across the upgrade is told of the wait it is in; one it left before the courier looked is passed over.
 */
const storedBefore = Effect.fn("Outcomes.storedBefore")(function* (
	conversation: Conversation.Conversation,
	submission: Thread.Newest,
	delivered: Mark,
): Effect.fn.Return<Due, Doc.Failure, Harness.Harness> {
	const nothing = Due.Nothing({ over: false });
	const ending = yield* Standing.endingOf(submission.record, conversation);
	if (Option.isNone(ending)) return nothing;
	// A wait whose verdict names its inputs was looked for in the transcript already.
	const verdict = verdictOf(ending.value);
	if (Option.isNone(verdict) || verdict.value.inputs !== undefined) return nothing;
	const head = yield* headOf(conversation);
	if (delivered.state === ending.value._tag && delivered.entry === head) return nothing;
	return Due.Reached({ submission, ending: ending.value, rests: Option.none(), settled: false });
});

/**
 * The verdict a wait rests on: what an open submission ends with is a wait (`Held`, `ReviewDeferred`, or
 * `BudgetStopped` with the deferred verdict). None for any other ending.
 */
function verdictOf(ending: Standing.Ending): Option.Option<Review.Verdict> {
	return Match.valueTags(ending, {
		Held: ({ verdict }) => Option.some(verdict),
		ReviewDeferred: ({ verdict }) => Option.some(verdict),
		BudgetStopped: ({ review }) => Option.fromUndefinedOr(review),
		Reviewed: () => Option.none(),
		Answered: () => Option.none(),
		NotReviewed: () => Option.none(),
		Errored: () => Option.none(),
		Cancelled: () => Option.none(),
	});
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
const planOf = Effect.fn("Outcomes.plan")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
	due: Exclude<Due, { readonly _tag: "Nothing" }>,
): Effect.fn.Return<{ readonly event: OutcomeEvent; readonly mark: Mark }, Failure, Composed> {
	const { key, attempt, record } = due.submission;
	const about = { thread, key, attempt };
	if (due._tag === "Started") {
		const mark: Mark = { submission: record.id, entry: 0, state: "Started" };
		return { mark, event: OutcomeEvent.cases.Started.make({ id: idOf(thread, mark), ...about }) };
	}
	if (due.settled) yield* Effect.timeoutOption(conversation.waitForIdle, IDLE_GRACE_MILLIS);
	const entry = Option.isSome(due.rests) ? due.rests.value : yield* headOf(conversation);
	const mark: Mark = { submission: record.id, entry, state: due.ending._tag };
	const outcome = yield* Counts.counted(thread, conversation, due.ending);
	return { mark, event: OutcomeEvent.cases.Reached.make({ id: idOf(thread, mark), ...about, outcome }) };
});
