// The thread service: admit a thread's task and work it to its end, take a stopped thread on, deliver a person's
// decision, cancel it and probe it, on the composed harness.

import { continueStopped, Shares } from "@effectified/pi-budget";
import type { ConversationId, SubmissionId } from "@effectified/pi-durable";
import {
	Agent,
	type Conversation,
	type DurableError,
	Harness,
	type SchemaDecodeError,
	type Signal,
	Submission,
} from "@effectified/pi-durable";
import { Conversations, Grant, type Guard, type MalformedRefusal } from "@effectified/pi-guard";
import { Recorder } from "@effectified/pi-recorder";
import * as Review from "@effectified/pi-review";
import { decodeUnknown } from "@effectified/pi-schema";
import type { SwarmFaulted } from "@effectified/pi-swarm";
import { Array as Arr, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Counts from "./counts.ts";
import { type ReviewerSharesFamily, ThreadNotFound } from "./errors.ts";
import type * as Forks from "./forks.ts";
import { RequestKey, ThreadKey } from "./ids.ts";
import { Outcome } from "./outcome.ts";
import * as Cursor from "./outcome-cursor.ts";
import { Reviewers } from "./reviewers.ts";
import * as Routing from "./routing.ts";
import * as Standing from "./standing.ts";
import * as Thread from "./thread.ts";

/**
 * What a product gives to have a thread worked: its own key for the thread, the task, the model (as Pi names one;
 * with the composition's router, an alias), the grant, and the micro units the thread may settle of the lease.
 */
export const Work = Schema.Struct({
	/** The product's key of the thread, which is also its idempotency key: working it twice is one thread. */
	thread: ThreadKey,
	/** The thread's first message. */
	task: Schema.String,
	model: Agent.ModelRef,
	/** Exactly the tools the thread may call, and the classification of what it holds, which its routes must allow. */
	grant: Grant.Grant,
	/** The thread's share of the harness's lease, in micro units. Its subagents and its swarms' forks have their own. */
	cap: Schema.BigInt,
	/**
	 * Whether the thread's answers are reviewed before they stand. Default true. With false the thread's conversation
	 * leaves the review extension out, nobody is asked, and a run that answers ends `Answered`.
	 */
	review: Schema.optionalKey(Schema.Boolean),
	/** The regions that may serve the thread and the labels its routes must carry. Default: any region, no label. */
	routing: Schema.optionalKey(Routing.Routing),
	instructions: Schema.optionalKey(Schema.String),
	/** The tool rounds one run takes at most: 1 or more, as Pi's `configure` takes it (`admit` refuses fewer). */
	maxTurns: Schema.optionalKey(Schema.Int),
});

/** What a product gives to have a thread worked. */
export type Work = typeof Work.Type;

/**
 * What a thread operation fails with: a failed Pi call, or a plugin that refused or could not read its own state,
 * among them a swarm of the thread whose stored coordinator is not this version's, which the thread's money is read
 * from.
 */
export type Failure =
	| DurableError
	| SchemaDecodeError
	| Conversations.GrantError
	| MalformedRefusal
	| Signal.Failure
	| Recorder.Failure
	| SwarmFaulted;

/**
 * What `admit` answers: `created` is false when the thread existed, and nothing of the input but its cap was applied;
 * `key` is the request key the thread's task is admitted under, the one of the call that created the thread.
 */
export const Admitted = Schema.Struct({ created: Schema.Boolean, key: RequestKey });

/** What `admit` answers. */
export type Admitted = typeof Admitted.Type;

/**
 * What `takeOn` did with a thread: `continued` a run that ended without an answer, asked for its deferred review
 * again (`retried`), or left it as it is (`unchanged`): it works, it ended in a way nothing continues, or its key was
 * used already.
 */
export const TakenOn = Schema.Literals(["continued", "retried", "unchanged"]);

/** What `takeOn` did with a thread. */
export type TakenOn = typeof TakenOn.Type;

/** What `probe` answers: whether the thread has unfinished work. */
export const Probe = Schema.Struct({ alive: Schema.Boolean });

/** What `probe` answers. */
export type Probe = typeof Probe.Type;

/**
 * The operations on threads, in the shape of a product's port to its agent runtime. `admit`, `takeOn` and `decide`
 * return once their work is durably admitted, for a host that cannot hold a call open (a Rivet action); `work`,
 * `resume` and `release` are the same followed by `ended`, which waits.
 */
export interface Service {
	/**
	 * Admits a thread's task and returns. Idempotent by `thread`: the first call creates the thread's conversation
	 * with its grant, its cap, its routing limits and its choice of review in one commit, with `key` as the request
	 * key of its task (default: `Thread.requestId(thread, 0)`), and admits the task under that key. A later call, also
	 * in another process and under another key, finds all of it, applies only `cap`, so a later call can raise it,
	 * and admits nothing new. A thread that asks for a review is not created when a route of the reviewer's alias is
	 * of the family of a route of its model (`ReviewerSharesFamily`).
	 */
	readonly admit: (input: Work, key?: RequestKey) => Effect.Effect<Admitted, Failure | ReviewerSharesFamily>;
	/**
	 * `admit`, then `ended`: works a thread to its end and gives its outcome. A thread parked for a person's approval
	 * has not ended: the call waits. A thread whose answer is held, or whose review is deferred, has ended as far as
	 * it goes by itself: the call returns.
	 */
	readonly work: (input: Work) => Effect.Effect<Outcome, Failure | ReviewerSharesFamily>;
	/**
	 * Takes a thread on from where it stopped, and returns:
	 *
	 * - a run that ended without an answer, for a stopped budget or an error, is continued on the transcript as it
	 *   is, under the request key `key` (default: the next of `Thread.requestId`). A key the thread already holds a
	 *   submission under continues nothing: the same key is the same work;
	 * - a review that is deferred, for a refused or a failed reviewer request, is asked for again. That is idempotent
	 *   by the review's state, not by `key`: a second call while the request is under way asks nothing.
	 *
	 * Call it once a lease covers the thread again. A thread that ended any other way keeps its outcome: a cancelled
	 * one stays cancelled, a held one waits for `decide`. Fails with `ThreadNotFound` for a key nothing was admitted
	 * under.
	 */
	readonly takeOn: (thread: ThreadKey, key?: RequestKey) => Effect.Effect<TakenOn, Failure | ThreadNotFound>;
	/** `takeOn`, then `ended`. */
	readonly resume: (thread: ThreadKey) => Effect.Effect<Outcome, Failure | ThreadNotFound>;
	/**
	 * Cancels a thread that works, is held or waits for its review: its run is aborted, a model request in flight
	 * included, and the Effect succeeds once the conversation is idle. A thread that ended keeps its outcome.
	 * Idempotent.
	 */
	readonly cancel: (thread: ThreadKey) => Effect.Effect<void, Failure | ThreadNotFound>;
	/**
	 * Delivers a person's decision to a held thread, and returns once it is stored: with `Accept` the answer then
	 * stands, with `Correct` the run goes on and its next answer is reviewed. Fails with `NotHeld` for a thread that
	 * is not held. Nothing checks who decides: authenticate the person in the host.
	 */
	readonly decide: (
		thread: ThreadKey,
		decision: Review.Decision,
	) => Effect.Effect<Review.Delivery, Failure | ThreadNotFound | Review.NotHeld>;
	/** `decide`, then a wait until the hold has ended, then `ended`: the outcome that follows the decision. */
	readonly release: (
		thread: ThreadKey,
		decision: Review.Decision,
	) => Effect.Effect<Outcome, Failure | ThreadNotFound | Review.NotHeld>;
	/**
	 * Whether the thread has unfinished work: also while it is parked, held, or waits for its review to be asked for
	 * again. False for an unknown key, and for a run the budget stopped before it answered.
	 */
	readonly probe: (thread: ThreadKey) => Effect.Effect<Probe, Failure>;
	/** The outcome the thread has now, read from the harness storage; none while it works. */
	readonly outcome: (thread: ThreadKey) => Effect.Effect<Option.Option<Outcome>, Failure | ThreadNotFound>;
	/**
	 * The outcome of a thread once it ended, waiting for that: a settled submission, a held answer or a deferred
	 * review, whichever comes first. The records of what the harness committed until then are in the sink before it
	 * returns.
	 */
	readonly ended: (thread: ThreadKey) => Effect.Effect<Outcome, Failure | ThreadNotFound>;
	/** The thread's conversation, for what a plugin takes one for: `Review.verdicts`, `Review.state`. */
	readonly conversation: (thread: ThreadKey) => Effect.Effect<Conversation.Conversation, Failure | ThreadNotFound>;
}

/** The thread operations of the composed harness. */
export class Threads extends Context.Service<Threads, Service>()("@effectified/pi-thread/threads") {}

/**
 * What the operations run on: the open harness, the plugins' services built on it, the reviewer check, and the
 * accounts of the forks of a thread's swarms.
 */
type Composed = Harness.Harness | Guard.Guard | Shares | Recorder.Recorder | Reviewers | Forks.Accounts;

/**
 * The thread operations on the harness, the guard, the shares, the recorder, the reviewer check and the fork accounts
 * of the context.
 */
export const layer: Layer.Layer<Threads, never, Composed> = Layer.effect(
	Threads,
	Effect.map(Effect.context<Composed>(), (composed) => {
		const here = <A, E>(effect: Effect.Effect<A, E, Composed>): Effect.Effect<A, E> =>
			Effect.provide(effect, composed);
		return Threads.of({
			admit: (input, key) =>
				here(Effect.map(admitted(input, key), ({ created, key: held }) => ({ created, key: held }))),
			work: (input) => here(worked(input)),
			takeOn: (thread, key) => here(takenOn(thread, key)),
			resume: (thread) => here(resumed(thread)),
			cancel: (thread) => here(cancelled(thread)),
			decide: (thread, decision) => here(decided(thread, decision)),
			release: (thread, decision) => here(released(thread, decision)),
			probe: (thread) => here(probed(thread)),
			outcome: (thread) => here(outcomeOf(thread)),
			ended: (thread) => here(awaited(thread)),
			conversation: (thread) => here(Thread.conversation(thread)),
		});
	}),
);

/**
 * `Service.admit`: one commit finds the thread's conversation by its key or creates it with its grant, its cap, its
 * routing limits, its choice of review, its first request key and the courier of its outcome events, so no thread
 * exists without any of them; then its task is admitted under that key. Each step finds what an earlier call left, so
 * a call that was cut off is completed by the next one. A thread whose agent Pi's `configure` would refuse, such as
 * `maxTurns: 0`, fails with `SchemaDecodeError` and is not created.
 */
const admitted = Effect.fn("Threads.admit")(function* (
	input: Work,
	key: RequestKey | undefined,
): Effect.fn.Return<
	Admitted & { readonly conversation: Conversation.Conversation },
	Failure | ReviewerSharesFamily,
	Composed
> {
	const shares = yield* Shares;
	const snapshot = yield* Harness.snapshot(Thread.Document, input.thread);
	const known = Option.flatMapNullishOr(snapshot, (held) => held.conversation);
	// Before the thread exists, and only for one that is reviewed: nothing is created, sent or paid for it.
	if (Option.isNone(known) && input.review !== false) {
		const reviewers = yield* Reviewers;
		yield* reviewers.check(input.thread, input.model);
	}
	const request = key ?? Thread.requestId(input.thread, 0);
	const stored = yield* Harness.commit(
		Effect.fnUntraced(function* (tx) {
			const document = yield* tx.doc(Thread.Document, input.thread, null);
			const held = yield* document.get;
			if (held.conversation !== null) {
				yield* shares.setCapIn(tx, held.conversation, input.cap);
				// Written with the conversation: a thread that has one has its first request key.
				const first = Option.getOrElse(Arr.head(held.requests), () => request);
				return { conversation: held.conversation, key: first, created: false };
			}
			// A change Pi's `configure` would refuse in this commit is refused before the conversation is created, typed,
			// and the commit stores nothing.
			const change: Agent.ByName = {
				...(input.instructions === undefined ? {} : { instructions: input.instructions }),
				...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
				// Pi asks only the hooks of the extensions a conversation selects: without it nothing is reviewed.
				...(input.review === false ? { extensions: { remove: [Review.NAME] } } : {}),
			};
			const agent = yield* decodeAgent(change);
			const created = yield* tx.createConversation({ ownership: { kind: "ownerless" } });
			yield* Conversations.grantIn(tx, created.id, input.grant, { model: input.model });
			yield* tx.configure(created.id, agent);
			yield* shares.setCapIn(tx, created.id, input.cap);
			yield* Routing.setIn(tx, created.id, input.routing ?? {});
			yield* document.set({ ...held, conversation: created.id, requests: [request] });
			yield* Cursor.openIn(tx, input.thread, created.id);
			return { conversation: created.id, key: request, created: true };
		}),
	);
	const conversation = yield* Thread.handleOf(stored.conversation);
	yield* Conversations.guarded(conversation);
	yield* conversation.submit({ type: "input", content: input.task, requestId: stored.key });
	return { created: stored.created, key: stored.key, conversation };
});

/** The agent change of a new thread, checked by the facade's `Agent.ByName`: the numbers Pi's `configure` takes. */
const decodeAgent = decodeUnknown(Agent.ByName);

/** `Service.work`. */
const worked = Effect.fn("Threads.work")(function* (
	input: Work,
): Effect.fn.Return<Outcome, Failure | ReviewerSharesFamily, Composed> {
	const { conversation } = yield* admitted(input, undefined);
	return yield* ended(input.thread, conversation);
});

/** `Service.resume`. */
const resumed = Effect.fn("Threads.resume")(function* (
	thread: ThreadKey,
): Effect.fn.Return<Outcome, Failure | ThreadNotFound, Composed> {
	yield* takenOn(thread, undefined);
	return yield* awaited(thread);
});

/** `Service.ended`: the thread's outcome once it has one. */
const awaited = Effect.fn("Threads.ended")(function* (
	thread: ThreadKey,
): Effect.fn.Return<Outcome, Failure | ThreadNotFound, Composed> {
	const conversation = yield* Thread.conversation(thread);
	return yield* ended(thread, conversation);
});

/** `Service.outcome`. */
const outcomeOf = Effect.fn("Threads.outcome")(function* (
	thread: ThreadKey,
): Effect.fn.Return<Option.Option<Outcome>, Failure | ThreadNotFound, Composed> {
	const conversation = yield* Thread.conversation(thread);
	const standing = yield* standingOf(thread, conversation);
	return Position.match(standing, {
		Working: () => Option.none(),
		Ended: ({ outcome }) => Option.some(outcome),
	});
});

/**
 * Where a thread stands: at work on a submission that has not settled, or ended with an outcome and the number of
 * its newest submission, which a continuation follows.
 */
const Position = Schema.TaggedUnion({
	Working: { submission: Submission.Id },
	Ended: { outcome: Outcome, attempt: Schema.Int },
});

/** Where a thread stands. */
type Position = typeof Position.Type;

/**
 * Where the thread stands now, read from what the harness stored and nothing else (`Standing.sight`), with the counts
 * of an ended one. So it says the same in a process that just opened the storage.
 */
const standingOf = Effect.fn("Threads.standingOf")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
): Effect.fn.Return<Position, Failure | ThreadNotFound, Composed> {
	const sight = yield* Standing.sight(thread, conversation);
	if (Option.isNone(sight)) return yield* ThreadNotFound.make({ thread });
	const { attempt, record, ending } = sight.value;
	if (Option.isNone(ending)) return Position.cases.Working.make({ submission: record.id });
	const outcome = yield* Counts.counted(thread, conversation, ending.value);
	return Position.cases.Ended.make({ attempt, outcome });
});

/**
 * The outcome of a thread once it ended, waiting for that: a settled submission, a held answer or a deferred review,
 * whichever comes first. The records of what the harness committed until then are in the sink before it returns.
 */
const ended = Effect.fn("Threads.endedIn")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
): Effect.fn.Return<Outcome, Failure, Composed> {
	while (true) {
		const standing = yield* standingOf(thread, conversation).pipe(
			// Every caller found the thread and a submission of it before this ran.
			Effect.catchTag("ThreadNotFound", () => Effect.die(new Error(`Thread ${thread} has no submission`))),
		);
		if (standing._tag === "Ended") {
			yield* Recorder.flushAll;
			return standing.outcome;
		}
		yield* settledOrWaiting(conversation, standing.submission);
	}
});

/**
 * Succeeds once `submission` settled and its run's work ended, or the conversation's review waits for somebody: a
 * person, for a held answer, or a new request, for a deferred review.
 */
function settledOrWaiting(
	conversation: Conversation.Conversation,
	submission: SubmissionId,
): Effect.Effect<void, Failure, Harness.Harness> {
	const settled = Effect.flatMap(
		Harness.submission(submission),
		Option.match({
			onNone: () => Effect.void,
			// The run's own tasks (`afterRun`) end after the submission settled: the counts are read once it is idle.
			onSome: (found: Submission.Submission) => Effect.andThen(found.wait, conversation.waitForIdle),
		}),
	);
	const waits = conversation.changes().pipe(
		Stream.mapEffect(() => Review.state(conversation)),
		Stream.filter(Review.State.isAnyOf(["Held", "Deferred"])),
		Stream.runHead,
		// The watch ends when the harness closes: only the submission's own wait says what became of it then.
		Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: () => Effect.void })),
	);
	return Effect.raceFirst(settled, waits);
}

/** `Service.takeOn`. */
const takenOn = Effect.fn("Threads.takeOn")(function* (
	thread: ThreadKey,
	key: RequestKey | undefined,
): Effect.fn.Return<TakenOn, Failure | ThreadNotFound, Composed> {
	const conversation = yield* Thread.conversation(thread);
	const standing = yield* standingOf(thread, conversation);
	if (standing._tag === "Working") return "unchanged";
	const { outcome, attempt } = standing;
	// The next request key: a second call for the same stop finds the continuation the first one admitted.
	const request = key ?? Thread.requestId(thread, attempt + 1);
	const next = continuedUnder(thread, conversation, request);
	// Asked already, or ended meanwhile by an abort: what stands is read by whoever waits.
	const again: Effect.Effect<TakenOn, Failure, Harness.Harness> = Review.retry(conversation).pipe(
		Effect.as("retried" as const),
		Effect.catchTag("NotDeferred", () => Effect.succeed("unchanged" as const)),
	);
	const left: Effect.Effect<TakenOn> = Effect.succeed("unchanged");
	return yield* Outcome.match(outcome, {
		Errored: () => next,
		// With a deferred verdict the answer is there, and it is the review that was refused.
		BudgetStopped: ({ review }) => (review === undefined ? next : again),
		ReviewDeferred: () => again,
		Reviewed: () => left,
		Answered: () => left,
		NotReviewed: () => left,
		Held: () => left,
		Cancelled: () => left,
	});
});

/**
 * Continues a run that ended without an answer, under the request key `request`, unless a submission holds that key
 * already: the same key is the same work.
 */
const continuedUnder = Effect.fn("Threads.continue")(function* (
	thread: ThreadKey,
	conversation: Conversation.Conversation,
	request: RequestKey,
): Effect.fn.Return<TakenOn, Failure, Harness.Harness> {
	const used = yield* Harness.commit((tx) => tx.submissionByRequest(conversation.id, request));
	if (Option.isSome(used)) return "unchanged";
	// The key first: a call that is cut off here has admitted nothing, and the next one does. With it, in one
	// commit, a courier for what the continuation comes to: the one of the stopped run has ended.
	yield* Harness.commit((tx) =>
		Effect.andThen(Cursor.wakeIn(tx, thread, conversation.id), Thread.noteRequestIn(tx, thread, request)),
	);
	yield* continueStopped(conversation, { requestId: request });
	return "continued";
});

/** `Service.cancel`. */
const cancelled = Effect.fn("Threads.cancel")(function* (
	thread: ThreadKey,
): Effect.fn.Return<void, Failure | ThreadNotFound, Composed> {
	const conversation = yield* Thread.conversation(thread);
	// Only a thread whose submission is open is aborted: an ended one keeps its outcome, and its swarms go on.
	const live = yield* open(thread, conversation.id);
	if (live) yield* conversation.abort();
});

/** `Service.decide`. */
const decided = Effect.fn("Threads.decide")(function* (
	thread: ThreadKey,
	decision: Review.Decision,
): Effect.fn.Return<Review.Delivery, Failure | ThreadNotFound | Review.NotHeld, Composed> {
	const conversation = yield* Thread.conversation(thread);
	return yield* Review.release(conversation, decision);
});

/** `Service.release`. */
const released = Effect.fn("Threads.release")(function* (
	thread: ThreadKey,
	decision: Review.Decision,
): Effect.fn.Return<Outcome, Failure | ThreadNotFound | Review.NotHeld, Composed> {
	const conversation = yield* Thread.conversation(thread);
	yield* Review.release(conversation, decision);
	// `release` returns once the decision is stored: the outcome is read once the review task has applied it.
	yield* Review.waitForHoldEnd(conversation);
	return yield* ended(thread, conversation);
});

/** `Service.probe`. */
const probed = Effect.fn("Threads.probe")(function* (thread: ThreadKey): Effect.fn.Return<Probe, Failure, Composed> {
	const conversation = yield* Effect.catchTag(
		Effect.asSome(Thread.find(thread)),
		"ThreadNotFound",
		() => Effect.succeedNone,
	);
	if (Option.isNone(conversation)) return { alive: false };
	const alive = yield* open(thread, conversation.value);
	return { alive };
});

/** Whether the thread's newest submission has not settled: the thread works, is parked, is held or waits. */
const open = Effect.fn("Threads.open")(function* (
	thread: ThreadKey,
	conversation: ConversationId,
): Effect.fn.Return<boolean, Failure, Harness.Harness> {
	const newest = yield* Thread.newest(conversation, thread);
	return Option.exists(newest, ({ record }) => !Submission.settled(record.status));
});
