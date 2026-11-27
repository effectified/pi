// The outcome of a thread: how its work ended and what it took, as a Schema a host can send across a boundary.

import { Refusal } from "@effectified/pi-budget";
import * as Review from "@effectified/pi-review";
import { Schema } from "effect";

/**
 * What a thread took so far, read from what the harness stored:
 *
 * - `turns`: the model responses of the thread's conversation that returned (an answer or a turn that calls tools).
 * - `toolCalls`: its tool results, refused calls included.
 * - `refusedToolCalls`: the calls the guard kept from running, by its own record in the call's result: a tool
 *   outside the grant, a denied name, a ceiling, an argument rule. A call a person denied is a tool call, not a
 *   refused one.
 * - `settledMicros`: what the budget settled for the thread, in micro units of the price table's currency. It is the
 *   whole of what the thread caused: its own requests and its review, a route attempt that failed and was taken
 *   over, the requests of its subagents at any depth, and those of the forks of every swarm run on it, whether a
 *   fork is a conversation of the thread's storage or an actor of its own. A swarm that runs after the thread ended
 *   therefore raises the amount of an outcome read later; `Swarms.spent` says what each job of a swarm took, for a
 *   product that reports the two apart. In a fork's copy of a thread it is what that fork settled for the thread,
 *   and nothing of what the thread had settled where it was copied from.
 */
export const Counts = Schema.Struct({
	turns: Schema.Int,
	toolCalls: Schema.Int,
	refusedToolCalls: Schema.Int,
	settledMicros: Schema.BigInt,
});

/** What a thread took so far. */
export type Counts = typeof Counts.Type;

/**
 * How a thread's work ended:
 *
 * - `Reviewed`: the newest answer passed its review, or was held and then accepted by a person (`accepted`).
 * - `Answered`: the thread asked for no review (`Work.review` false), and its run ended with an answer. Nothing
 *   judged the answer here: it is ready for whatever review the product has outside.
 * - `NotReviewed`: the run ended with an answer that does not stand as reviewed; `reason` is the review's own.
 * - `Held`: the newest answer has a blocking finding and no correction left. The thread waits for a person.
 * - `ReviewDeferred`: the reviewer's request failed, for a reason that is no budget refusal, so nothing judged the
 *   answer; `reason` is the provider's error text. The thread waits for `Threads.resume`, which reviews again.
 * - `BudgetStopped`: the budget refused a request, which was not sent; `refusal` says why. Without `review` it was a
 *   request of the run, which ended without an answer. With `review` it was the reviewer's: the answer is there, and
 *   `review` is the deferred verdict. Either way `Threads.resume` goes on once a lease covers the thread again.
 * - `Errored`: the run ended without an answer for any other reason; `reason` is Pi's word for it.
 * - `Cancelled`: the thread was cancelled before it ended.
 *
 * Choose with `Outcome.match`; `Outcome.guards` tests for one.
 */
export const Outcome = Schema.TaggedUnion({
	Reviewed: { counts: Counts, verdict: Review.Verdict, accepted: Schema.Boolean },
	Answered: { counts: Counts },
	NotReviewed: { counts: Counts, reason: Review.Reason, verdict: Schema.optionalKey(Review.Verdict) },
	Held: { counts: Counts, verdict: Review.Verdict },
	ReviewDeferred: {
		counts: Counts,
		verdict: Review.Verdict,
		/** The number of the reviewer's request that failed, from 1. */
		attempt: Schema.Int,
		reason: Schema.String,
	},
	BudgetStopped: { counts: Counts, refusal: Refusal, review: Schema.optionalKey(Review.Verdict) },
	Errored: { counts: Counts, reason: Schema.String, detail: Schema.NullOr(Schema.String) },
	Cancelled: { counts: Counts },
});

/** How a thread's work ended. */
export type Outcome = typeof Outcome.Type;
