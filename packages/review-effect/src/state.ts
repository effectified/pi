// The review state of a conversation: what the verdict on its newest answer, a person's decision about it and Pi's
// live run say together. Read from the harness storage, so it is the same after a restart.

import {
	AssistantEntry,
	BuiltinDoc,
	type Conversation,
	type DurableError,
	Entry,
	type EntryId,
	type EntryRecord,
	Harness,
	type SchemaDecodeError,
	Signal,
	Task,
	type TaskId,
} from "@effectified/pi-durable";
import { Array as Arr, Effect, Option, Schema, Stream } from "effect";
import * as Deferral from "./deferral.ts";
import { NAME } from "./extension.ts";
import * as Hold from "./hold.ts";
import * as ModelReview from "./model-review.ts";
import * as Run from "./run.ts";
import { Ordinal, Outcome, Unreviewed, Verdict, VerdictEntry } from "./verdict.ts";

/**
 * Why a conversation's newest answer is not reviewed: a reason of its verdict (`Unreviewed`), or
 *
 * - `no_answer`: the conversation has no answer.
 * - `no_verdict`: the answer has no verdict, in a conversation that selects the review extension. The review never
 *   ran or never finished: another `onYield` hook answered first, the review task faulted, the extension was not
 *   selected when the answer was given, or Pi ended the run at its restart limit.
 * - `correction_dropped`: a correction was asked for and Pi did not take it, because a user message or a reset was
 *   queued, and nothing has answered since.
 * - `hold_ended`: the answer was held and the hold ended without a decision: the conversation was aborted.
 * - `request_failed`: the review was deferred because the reviewer's request failed, and its task ended without
 *   reviewing again and without a verdict of its own.
 */
export const Reason = Schema.Literals([
	...Unreviewed.literals,
	"no_answer",
	"no_verdict",
	"correction_dropped",
	"hold_ended",
	"request_failed",
]);

/** Why a conversation's newest answer is not reviewed. */
export type Reason = typeof Reason.Type;

/**
 * The review state of a conversation. `State.match` picks a handler per tag and `State.guards` tests for one:
 *
 * - `InReview`: the conversation works on an answer that has no final verdict: its author writes, a review runs, a
 *   corrective run goes on (`verdict` is then the one the correction answers), or a deferred review was asked again
 *   (`verdict` is then the deferred one).
 * - `Reviewed`: the newest answer passed its review. It stands.
 * - `Accepted`: the newest answer was held, and a person accepted it as it is.
 * - `Held`: the newest answer has a blocking finding and no correction left. The review task `task` waits for
 *   `release`; until then the run's inputs stay open.
 * - `Released`: the hold has its `decision`, durably, and the harness has not run the review task since. Nobody is
 *   waited for: the decision is applied when a harness next schedules the task.
 * - `Deferred`: the reviewer's request for the newest answer failed, so nothing judged the answer. `reason` is the
 *   provider's error text. The review task `task` waits for `retry`; until then the run's inputs stay open.
 * - `NotRequired`: the conversation does not select the review extension, and its newest answer has no verdict.
 *   Nothing is missing: no review was asked for.
 * - `NotReviewed`: the run ended, or never started, and the newest answer does not stand as reviewed.
 */
export const State = Schema.TaggedUnion({
	InReview: { verdict: Schema.optionalKey(Verdict) },
	Reviewed: { verdict: Verdict },
	Accepted: { verdict: Verdict, release: Hold.Release },
	Held: { verdict: Verdict, task: Task.Id },
	Released: { verdict: Verdict, task: Task.Id, decision: Hold.Decision },
	Deferred: {
		verdict: Verdict,
		task: Task.Id,
		/** The number of the request that failed, from 1: `retry` asks for the next one. */
		attempt: Ordinal,
		reason: Schema.String,
	},
	NotRequired: {},
	NotReviewed: { reason: Reason, verdict: Schema.optionalKey(Verdict) },
});

/** The review state of a conversation. */
export type State = typeof State.Type;

/**
 * A wait of a review: the state a verdict that held its answer (`Held`) or deferred its review (`Deferred`) put the
 * conversation in when it was stored, in the commit that put its review task to sleep. `Wait.match` picks a handler
 * per tag.
 */
export const Wait = Schema.Union([State.cases.Held, State.cases.Deferred]).pipe(Schema.toTaggedUnion("_tag"));

/** A wait of a review. */
export type Wait = typeof Wait.Type;

/** What reading the review state fails with: a failed Pi call, or a stored entry of this package that does not decode. */
export type Failure = DurableError | SchemaDecodeError;

/** Entries per storage read on the way back to the newest answer. */
const RECENT = 16;

/**
 * The review state of `conversation` now. It is bound to the newest assistant entry: a verdict about an older answer
 * never speaks for a newer one, so an answer whose review did not happen reads `NotReviewed`, never `Reviewed`.
 * Committed reads, not one transaction: Pi's live document first, then the entries back to the newest answer, then
 * the review task of an answer that is held or deferred, or the conversation's agent for an answer without a
 * verdict.
 */
export const state: (conversation: Conversation.Conversation) => Effect.Effect<State, Failure, Harness.Harness> =
	Effect.fn("Review.state")(function* (conversation: Conversation.Conversation) {
		const live = yield* Harness.snapshot(BuiltinDoc.live, conversation.id);
		const run = Run.view(live);
		// Newest first, down to the newest assistant entry: the answer, and what this package stored after it. That is
		// a handful of entries, so the pages are small.
		const recent = yield* Stream.runCollect(
			Stream.takeUntil(conversation.entries({ pageSize: RECENT }), (entry) => AssistantEntry.is(entry)),
		);
		const answer = Arr.findLast(recent, (entry) => AssistantEntry.is(entry));
		if (Option.isNone(answer)) return yield* unjudged(conversation, run, "no_answer");
		const verdict = yield* newestAbout(recent, VerdictEntry, answer.value.id);
		if (Option.isNone(verdict)) return yield* unjudged(conversation, run, "no_verdict");
		return yield* judged(run, recent, verdict.value);
	});

/**
 * The state of a newest answer without a verdict, `reason` saying which: `NotRequired` in a conversation that does
 * not select the extension, whose hooks Pi never asks; otherwise in review while the run works, and not reviewed once
 * it ended.
 */
const unjudged = Effect.fn("Review.unjudged")(function* (
	conversation: Conversation.Conversation,
	run: Run.View,
	reason: Reason,
) {
	const agent = yield* conversation.agent;
	if (!Arr.some(agent.extensions, (extension) => extension.name === NAME)) return State.cases.NotRequired.make({});
	return unsettled(run, reason, Option.none());
});

/**
 * The state `verdict`, the newest answer's, gives with what followed it: a person's decision for a held answer, the
 * waiting task for a held or deferred one, and Pi's live run, which may already work on a newer answer.
 */
function judged(
	run: Run.View,
	recent: ReadonlyArray<EntryRecord>,
	verdict: Verdict,
): Effect.Effect<State, Failure, Harness.Harness> {
	// A live run that decides about another answer, or about none yet, works on a newer one than the verdict's.
	const superseded = run.working && !Option.contains(run.yielded, verdict.answer);
	const settled = (decided: State): State => (superseded ? State.cases.InReview.make({}) : decided);
	return Outcome.match(verdict.outcome, {
		Passed: () => Effect.succeed(settled(State.cases.Reviewed.make({ verdict }))),
		NotReviewed: ({ reason }) => Effect.succeed(settled(State.cases.NotReviewed.make({ reason, verdict }))),
		Corrected: () => Effect.succeed(unsettled(run, "correction_dropped", Option.some(verdict))),
		Held: ({ task }) => held(run, recent, verdict, task, settled),
		Deferred: (deferred) => postponed(verdict, deferred, settled),
	});
}

/**
 * The state of a held answer: accepted or corrected by a decision recorded since, released by one delivered and not
 * yet taken, held while nobody decided, and not reviewed once the hold ended without a decision.
 */
const held = Effect.fn("Review.held")(function* (
	run: Run.View,
	recent: ReadonlyArray<EntryRecord>,
	verdict: Verdict,
	task: TaskId,
	settled: (decided: State) => State,
) {
	const release = yield* newestAbout(recent, Hold.ReleaseEntry, verdict.answer);
	if (Option.isSome(release)) {
		return Hold.Decision.match(release.value.decision, {
			Accept: () => settled(State.cases.Accepted.make({ verdict, release: release.value })),
			Correct: () => unsettled(run, "correction_dropped", Option.some(verdict)),
		});
	}
	const waiting = yield* live(task);
	if (Option.isNone(waiting)) return settled(State.cases.NotReviewed.make({ reason: "hold_ended", verdict }));
	const decision = yield* delivered(waiting.value, Hold.Released, Hold.KEY);
	return Option.match(decision, {
		onNone: () => State.cases.Held.make({ verdict, task }),
		onSome: (value) => State.cases.Released.make({ verdict, task, decision: value }),
	});
});

/**
 * The state of a deferred review: deferred while its task waits, in review once it was asked again, and not reviewed
 * once the task ended without reviewing again.
 */
const postponed = Effect.fn("Review.postponed")(function* (
	verdict: Verdict,
	outcome: typeof Outcome.cases.Deferred.Type,
	settled: (decided: State) => State,
) {
	const waiting = yield* live(outcome.task);
	if (Option.isNone(waiting)) return settled(State.cases.NotReviewed.make({ reason: "request_failed", verdict }));
	// Asked again: the task reviews, or is about to, and its next verdict is not stored yet.
	const retried = yield* delivered(waiting.value, Deferral.Retried, Deferral.key(outcome.attempt));
	return Option.isSome(retried) ? State.cases.InReview.make({ verdict }) : deferral(verdict, outcome);
});

/** The state of an answer that does not stand: in review while the run works, not reviewed for `reason` once it ended. */
function unsettled(run: Run.View, reason: Reason, verdict: Option.Option<Verdict>): State {
	const about = Option.match(verdict, { onNone: () => ({}), onSome: (value) => ({ verdict: value }) });
	return run.working ? State.cases.InReview.make(about) : State.cases.NotReviewed.make({ reason, ...about });
}

/**
 * The wait `verdict` put its conversation in when it was stored: `Held` for a held answer, `Deferred` for a deferred
 * review, with its `reason`; none for every other outcome, which waits for nobody. Read from the verdict alone, so it
 * is the same for a verdict stored long ago and whatever followed it: a decision, a retry, an abort. `state` gives the
 * same value while the wait lasts.
 */
export function waitOf(verdict: Verdict): Option.Option<Wait> {
	return Outcome.match(verdict.outcome, {
		Held: ({ task }) => Option.some<Wait>(State.cases.Held.make({ verdict, task })),
		Deferred: (outcome) => Option.some<Wait>(deferral(verdict, outcome)),
		Passed: () => Option.none(),
		Corrected: () => Option.none(),
		NotReviewed: () => Option.none(),
	});
}

/** The deferral of `verdict`, whose outcome is `outcome`: its task, its attempt, and the provider's error text. */
function deferral(verdict: Verdict, outcome: typeof Outcome.cases.Deferred.Type): typeof State.cases.Deferred.Type {
	const failed = Arr.findFirst(verdict.failures, (failure) => failure.check === ModelReview.NAME);
	const reason =
		verdict.call?.error ??
		Option.getOrElse(
			Option.map(failed, (failure) => failure.error),
			() => "",
		);
	return State.cases.Deferred.make({ verdict, task: outcome.task, attempt: outcome.attempt, reason });
}

/** Where `verdicts` starts reading: `from`, the first entry read; a verdict before it is not given. */
export const VerdictsQuery = Schema.Struct({ from: Schema.optionalKey(Entry.Id) });

/** Where `verdicts` starts reading. Default: the conversation's first entry. */
export type VerdictsQuery = typeof VerdictsQuery.Type;

/**
 * Every verdict stored in `conversation`, oldest first, each as its entry: `data` is the verdict, `id` the entry.
 * It ends with the newest one stored when it was read; it does not follow the conversation. With `from`, it starts
 * there: a reader that keeps where it stopped reads only what was stored since.
 */
export function verdicts(
	conversation: Conversation.Conversation,
	query: VerdictsQuery = {},
): Stream.Stream<Entry.Typed<Verdict>, Failure> {
	return conversation
		.entries({ order: "ascending", ...(query.from === undefined ? {} : { minEntryId: query.from }) })
		.pipe(
			Stream.mapEffect((entry) => VerdictEntry.read(entry)),
			Stream.filter(Option.isSome),
			Stream.map((found) => found.value),
		);
}

/** The record of a waiting review task a signal can still reach: none once it ended, or holds its outcome. */
function live(task: TaskId) {
	return Effect.map(
		Harness.getTask(task),
		Option.filter((record) => !Task.ended(record.state.status)),
	);
}

/**
 * The value delivered to a waiting task under `key` of `signal`: none while nothing was, and when the key expired.
 * A memo another version of the signal stored fails with `SchemaDecodeError`.
 */
function delivered<S extends Schema.Constraint>(record: Signal.Stored, signal: Signal.Signal<S>, key: string) {
	return Signal.stateIn(record, signal, key).pipe(
		Effect.map(Option.flatMap((state) => (state.kind === "value" ? Option.some(state.value) : Option.none()))),
	);
}

/**
 * Of the recent entries, newest first, the data of the newest entry of `entry`'s kind about `answer`: what the review
 * stored about the newest answer. A stored entry of that kind that does not decode fails with `SchemaDecodeError`.
 */
function newestAbout<A extends { readonly answer: EntryId }>(
	recent: ReadonlyArray<EntryRecord>,
	entry: {
		readonly read: (record: EntryRecord) => Effect.Effect<Option.Option<{ readonly data: A }>, SchemaDecodeError>;
	},
	answer: EntryId,
): Effect.Effect<Option.Option<A>, SchemaDecodeError> {
	return Effect.map(
		Effect.forEach(recent, (record) => entry.read(record), { concurrency: 1 }),
		(found) =>
			Option.map(
				Arr.findFirst(Arr.getSomes(found), (typed) => typed.data.answer === answer),
				(typed) => typed.data,
			),
	);
}
