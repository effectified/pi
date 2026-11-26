// Where a thread stands: at work, or ended with an outcome, read from what the harness stored and nothing else.

import type { RunFailureReason, SubmissionRecord } from "@earendil-works/pi-durable";
import { refusalOf } from "@effectified/pi-budget";
import type { Conversation, Doc, Harness } from "@effectified/pi-durable";
import * as Review from "@effectified/pi-review";
import { Effect, Option } from "effect";
import type { Outcome } from "./outcome.ts";
import * as Thread from "./thread.ts";

/** How a thread ended, before what it took is counted. */
export type Ending = Outcome extends infer Each ? (Each extends Outcome ? Omit<Each, "counts"> : never) : never;

/**
 * A thread's newest submission, and how the thread ended by it: `ending` is none while the thread works, which it
 * also does while a call is parked for a person.
 */
export interface Sight extends Thread.Newest {
	readonly ending: Option.Option<Ending>;
}

/**
 * The thread's newest submission and how the thread ended by it; none before its task was admitted. Read from what
 * the harness stored: the submission's record (Pi's), the review state (the review's verdict and release entries, and
 * its waiting task), and the refusal in a failed run's detail or in a deferred review's reason (the budget's). So it
 * says the same in a process that just opened the storage. A handful of reads, and no pass over the transcript.
 */
export function sight(
	thread: string,
	conversation: Conversation.Conversation,
): Effect.Effect<Option.Option<Sight>, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const newest = yield* Thread.newest(conversation.id, thread);
		if (Option.isNone(newest)) return Option.none();
		const ending = yield* endingOf(newest.value.record, conversation);
		return Option.some({ ...newest.value, ending });
	});
}

/**
 * How the thread ended by its submission `record`; none while it works. A submission that waits for its review ends
 * the thread as far as it goes by itself, and one that settled by what the review says of the newest answer, or by
 * the reason Pi gave when no answer came.
 */
export function endingOf(
	record: SubmissionRecord,
	conversation: Conversation.Conversation,
): Effect.Effect<Option.Option<Ending>, Review.Failure, Harness.Harness> {
	switch (record.status) {
		case "queued":
		case "placed":
			// A held answer and a deferred review never settle their submission: the thread has ended as far as it goes
			// by itself.
			return Effect.flatMap(Review.state(conversation), waiting);
		case "unanswered":
			return Effect.asSome(unanswered(record.reason, record.detail));
		case "done":
			return Effect.flatMap(Review.state(conversation), (state) =>
				Effect.map(
					waiting(state),
					Option.orElse(() => answered(state)),
				),
			);
	}
}

/**
 * How a thread whose run is open ended, when its review waits for somebody: held for a person, or deferred until
 * its reviewer can be asked again. None while the run works, a decision is being applied, or a retry is under way.
 */
function waiting(state: Review.State): Effect.Effect<Option.Option<Ending>> {
	switch (state._tag) {
		case "Held":
		case "Deferred":
			return Effect.asSome(waited(state));
		case "InReview":
		case "Released":
		case "Reviewed":
		case "Accepted":
		case "NotRequired":
		case "NotReviewed":
			return Effect.succeedNone;
	}
}

/**
 * How a thread stands while its review waits for somebody: `Held` for a person, `ReviewDeferred` until its reviewer can
 * be asked again, or `BudgetStopped` with the deferred verdict when the budget refused the reviewer's request. The
 * same for a wait read from its verdict alone (`Review.waitOf`), long after it ended.
 */
export function waited(wait: Review.Wait): Effect.Effect<Ending> {
	switch (wait._tag) {
		case "Held":
			return Effect.succeed({ _tag: "Held", verdict: wait.verdict });
		case "Deferred": {
			const { verdict, attempt, reason } = wait;
			// The budget's refusal reaches the review as the error text of the reviewer's request.
			return Effect.map(
				refusalOf(reason),
				Option.match({
					onNone: (): Ending => ({ _tag: "ReviewDeferred", verdict, attempt, reason }),
					onSome: (refusal): Ending => ({ _tag: "BudgetStopped", refusal, review: verdict }),
				}),
			);
		}
	}
}

/** Pi's reason of a submission whose run `Conversation.abort` ended before it answered: one of its run failures. */
const ABORTED = "aborted" satisfies RunFailureReason;

/** How a run that ended without an answer ended the thread: cancelled, stopped by the budget, or failed. */
function unanswered(reason: string, detail: unknown): Effect.Effect<Ending> {
	if (reason === ABORTED) return Effect.succeed({ _tag: "Cancelled" });
	return Effect.map(
		refusalOf(detail),
		Option.match({
			// Stored input: Pi types a detail as any JSON value, and gives a failed run's as text.
			onNone: (): Ending => ({ _tag: "Errored", reason, detail: typeof detail === "string" ? detail : null }),
			onSome: (refusal): Ending => ({ _tag: "BudgetStopped", refusal }),
		}),
	);
}

/**
 * The review's reasons that only an abort gives: the conversation was aborted while its review ran or waited to run
 * again (the review's own verdict says so), or while its answer was held.
 */
const ABORTED_REVIEW: ReadonlyArray<Review.Reason> = ["review_aborted", "hold_ended"];

/** How a run that answered ended the thread, by what the review says of the answer; none while a run goes on. */
function answered(state: Review.State): Option.Option<Ending> {
	switch (state._tag) {
		case "Reviewed":
			return Option.some({ _tag: "Reviewed", verdict: state.verdict, accepted: false });
		case "Accepted":
			return Option.some({ _tag: "Reviewed", verdict: state.verdict, accepted: true });
		case "NotRequired":
			return Option.some({ _tag: "Answered" });
		case "NotReviewed": {
			// Pi settles the inputs of a run aborted under review `done`: the review's reason tells it from an answer.
			if (ABORTED_REVIEW.includes(state.reason)) return Option.some({ _tag: "Cancelled" });
			const { reason, verdict } = state;
			return Option.some({ _tag: "NotReviewed", reason, ...(verdict === undefined ? {} : { verdict }) });
		}
		// The states of an open run, which `waiting` reads.
		case "InReview":
		case "Released":
		case "Held":
		case "Deferred":
			return Option.none();
	}
}
