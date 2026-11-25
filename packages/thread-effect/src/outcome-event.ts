// The events of a thread's outcome: its work started, and each state it reached, each with a deterministic id.

import { Submission } from "@gunta/pi-durable-effect";
import { Schema } from "effect";
import { Outcome } from "./outcome.ts";

/** The state an event tells: `Started`, or the `_tag` of the outcome reached. */
const STATES = [
	"Started",
	"Reviewed",
	"Answered",
	"NotReviewed",
	"Held",
	"ReviewDeferred",
	"BudgetStopped",
	"Errored",
	"Cancelled",
] as const satisfies ReadonlyArray<"Started" | Outcome["_tag"]>;

/** What both events say of the submission they are about. */
const about = {
	/** The product's key of the thread. */
	thread: Schema.String,
	/** The request key the submission was admitted under: the one `Threads.admit` or `Threads.takeOn` was given. */
	key: Schema.String,
	/** The number of the submission among the thread's: 0 is its task, 1 and up are continuations. */
	attempt: Schema.Int,
};

/**
 * The thread's work started: its task, or a continuation of a run that ended without an answer, was admitted. One per
 * submission of the thread.
 *
 * `id` is `<thread>:<submission>:started`, with Pi's id of the submission.
 */
export const Started = Schema.TaggedStruct("Started", { id: Schema.String, ...about });

/** The thread's work started. */
export type Started = typeof Started.Type;

/**
 * The thread reached an outcome: any member of `Outcome`, as `Threads.outcome` gives it, with the counts as they were
 * when the state was first read for delivery. A thread reaches several in a row when a held answer is released or a
 * deferred review is asked for again: `Held`, then `Reviewed`. Each wait of the review is one, also one the thread
 * left before it was told.
 *
 * `id` is `<thread>:<submission>:<entry>:<state>`: Pi's id of the submission the state rests on, the entry it rests
 * on, and the outcome's `_tag`. A wait of the review (`Held`, `ReviewDeferred`, or `BudgetStopped` with the deferred
 * verdict) rests on the verdict that began it; any other outcome on the newest entry of the thread's conversation when
 * it was read (0 for none). A state of one submission that comes again, such as a second hold, rests on a newer
 * entry: the verdict that holds it.
 */
export const Reached = Schema.TaggedStruct("Reached", { id: Schema.String, ...about, outcome: Outcome });

/** The thread reached an outcome. */
export type Reached = typeof Reached.Type;

/**
 * What an outcome sink is told: `Started` once per submission of a thread, then every outcome the thread reaches by
 * it. A thread parked for a person's approval is no event here: its submission is open, so it has no outcome, and
 * the product's `Approvals.Inbox` is told of every parked call under the request's own id.
 */
export const OutcomeEvent = Schema.Union([Started, Reached]);

/** What an outcome sink is told. */
export type OutcomeEvent = typeof OutcomeEvent.Type;

/**
 * What identifies a delivered event beside its thread: the submission, the entry the state rests on (0 for
 * `Started`, so a number and no entry id), and the state. It is what an event's id is made of, and what the delivery
 * cursor keeps.
 */
export const Mark = Schema.Struct({
	submission: Submission.Id,
	entry: Schema.Number,
	state: Schema.Literals(STATES),
});

/** What identifies a delivered event beside its thread. */
export type Mark = typeof Mark.Type;

/** The id of the event `mark` of the thread `thread`. */
export function idOf(thread: string, mark: Mark): string {
	return mark.state === "Started"
		? `${thread}:${mark.submission}:started`
		: `${thread}:${mark.submission}:${mark.entry}:${mark.state}`;
}
