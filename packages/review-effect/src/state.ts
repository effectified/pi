// The review state of a conversation: what the verdict on its newest answer, a person's decision about it and Pi's
// live run say together. Read from the harness storage, so it is the same after a restart.

import { AssistantEntry, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import {
	BuiltinDoc,
	type Conversation,
	type DurableError,
	type Entry,
	Harness,
	type SchemaDecodeError,
	Signal,
	Task,
} from "@gunta/pi-durable-effect";
import { Effect, Option, Schema, Stream } from "effect";
import * as Deferral from "./deferral.ts";
import { NAME } from "./extension.ts";
import * as Hold from "./hold.ts";
import * as ModelReview from "./model-review.ts";
import * as Run from "./run.ts";
import { Unreviewed, Verdict, VerdictEntry } from "./verdict.ts";

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
 * The review state of a conversation:
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
export const State = Schema.Union([
	Schema.TaggedStruct("InReview", { verdict: Schema.optionalKey(Verdict) }),
	Schema.TaggedStruct("Reviewed", { verdict: Verdict }),
	Schema.TaggedStruct("Accepted", { verdict: Verdict, release: Hold.Release }),
	Schema.TaggedStruct("Held", { verdict: Verdict, task: Task.Id }),
	Schema.TaggedStruct("Released", { verdict: Verdict, task: Task.Id, decision: Hold.Decision }),
	Schema.TaggedStruct("Deferred", {
		verdict: Verdict,
		task: Task.Id,
		/** The number of the request that failed, from 1: `retry` asks for the next one. */
		attempt: Schema.Number,
		reason: Schema.String,
	}),
	Schema.TaggedStruct("NotRequired", {}),
	Schema.TaggedStruct("NotReviewed", { reason: Reason, verdict: Schema.optionalKey(Verdict) }),
]);

/** The review state of a conversation. */
export type State = typeof State.Type;

/**
 * A wait of a review: the state a verdict that held its answer (`Held`) or deferred its review (`Deferred`) put the
 * conversation in when it was stored, in the commit that put its review task to sleep.
 */
export type Wait = Extract<State, { readonly _tag: "Held" | "Deferred" }>;

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
export function state(conversation: Conversation.Conversation): Effect.Effect<State, Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const run = Run.view(yield* Harness.snapshot(BuiltinDoc.live, conversation.id));
		// Newest first, down to the newest assistant entry: the answer, and what this package stored after it. That is
		// a handful of entries, so the pages are small.
		const recent = yield* Stream.runCollect(
			Stream.takeUntil(conversation.entries({ pageSize: RECENT }), (entry) => AssistantEntry.is(entry)),
		);
		const answer = recent.findLast((entry) => AssistantEntry.is(entry));
		const unanswered = (reason: Reason, verdict?: Verdict): State =>
			run.working
				? { _tag: "InReview", ...(verdict === undefined ? {} : { verdict }) }
				: { _tag: "NotReviewed", reason, ...(verdict === undefined ? {} : { verdict }) };
		const verdict =
			answer === undefined
				? undefined
				: about(yield* Effect.forEach(recent, (entry) => VerdictEntry.read(entry)), answer.id);
		if (verdict === undefined) {
			// No hook of this package is asked in a conversation that does not select the extension.
			const agent = yield* conversation.agent;
			if (!agent.extensions.some((extension) => extension.name === NAME)) return { _tag: "NotRequired" };
			return unanswered(answer === undefined ? "no_answer" : "no_verdict");
		}
		// A live run that decides about another answer, or about none yet, works on a newer one than the verdict's.
		const superseded = run.working && Option.getOrUndefined(run.yielded) !== verdict.answer;
		const settled = (decided: State): State => (superseded ? { _tag: "InReview" } : decided);
		switch (verdict.outcome._tag) {
			case "Passed":
				return settled({ _tag: "Reviewed", verdict });
			case "NotReviewed":
				return settled({ _tag: "NotReviewed", reason: verdict.outcome.reason, verdict });
			case "Corrected":
				return unanswered("correction_dropped", verdict);
			case "Held": {
				const release = about(
					yield* Effect.forEach(recent, (entry) => Hold.ReleaseEntry.read(entry)),
					verdict.answer,
				);
				if (release?.decision._tag === "Accept") return settled({ _tag: "Accepted", verdict, release });
				if (release?.decision._tag === "Correct") return unanswered("correction_dropped", verdict);
				const task = verdict.outcome.task;
				const waiting = yield* live(task);
				if (Option.isNone(waiting)) return settled({ _tag: "NotReviewed", reason: "hold_ended", verdict });
				const decision = yield* delivered(waiting.value, Hold.Released, Hold.KEY);
				return Option.isSome(decision)
					? { _tag: "Released", verdict, task, decision: decision.value }
					: { _tag: "Held", verdict, task };
			}
			case "Deferred": {
				const { task, attempt } = verdict.outcome;
				const waiting = yield* live(task);
				if (Option.isNone(waiting)) return settled({ _tag: "NotReviewed", reason: "request_failed", verdict });
				// Asked again: the task reviews, or is about to, and its next verdict is not stored yet.
				const retried = yield* delivered(waiting.value, Deferral.Retried, Deferral.key(attempt));
				if (Option.isSome(retried)) return { _tag: "InReview", verdict };
				return deferral(verdict, verdict.outcome);
			}
		}
	});
}

/**
 * The wait `verdict` put its conversation in when it was stored: `Held` for a held answer, `Deferred` for a deferred
 * review, with its `reason`; none for every other outcome, which waits for nobody. Read from the verdict alone, so it
 * is the same for a verdict stored long ago and whatever followed it: a decision, a retry, an abort. `state` gives the
 * same value while the wait lasts.
 */
export function waitOf(verdict: Verdict): Option.Option<Wait> {
	switch (verdict.outcome._tag) {
		case "Held":
			return Option.some({ _tag: "Held", verdict, task: verdict.outcome.task });
		case "Deferred":
			return Option.some(deferral(verdict, verdict.outcome));
		case "Passed":
		case "Corrected":
		case "NotReviewed":
			return Option.none();
	}
}

/** The deferral of `verdict`, whose outcome is `outcome`: its task, its attempt, and the provider's error text. */
function deferral(
	verdict: Verdict,
	outcome: Extract<Verdict["outcome"], { readonly _tag: "Deferred" }>,
): Extract<State, { readonly _tag: "Deferred" }> {
	const failed = verdict.failures.find((failure) => failure.check === ModelReview.NAME)?.error ?? "";
	const { task, attempt } = outcome;
	return { _tag: "Deferred", verdict, task, attempt, reason: verdict.call?.error ?? failed };
}

/** Where `verdicts` starts reading. */
export interface VerdictsQuery {
	/** The first entry read: a verdict before it is not given. Default: the conversation's first entry. */
	readonly from?: EntryId;
}

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
		// The signals of this package have fixed schemas with a JSON Schema: one Pi cannot take is a defect of this
		// package, not a failure of what was stored.
		Effect.catchTag("SchemaConversionError", (error) => Effect.die(error)),
		Effect.map(Option.flatMap((state) => (state.kind === "value" ? Option.some(state.value) : Option.none()))),
	);
}

/** Of the entries of one kind `found` among the recent ones, newest first, the data of the newest about `answer`. */
function about<A extends { readonly answer: EntryId }>(
	found: ReadonlyArray<Option.Option<{ readonly data: A }>>,
	answer: EntryId,
): A | undefined {
	return found.flatMap(Option.toArray).find((entry) => entry.data.answer === answer)?.data;
}
