// The hold: what a person decides about a held answer, the signal that carries the decision to the waiting review
// task, and the entry that records it.

import { Entry, Signal } from "@effectified/pi-durable";
import { Schema } from "effect";

/**
 * What a person decides about a held answer:
 *
 * - `Accept`: the answer stands as it is, with its findings.
 * - `Correct`: the run continues with `correction` as a user message, and the next answer is reviewed again.
 *
 * `by` is an opaque principal the host supplies after it authenticated the person.
 */
export const Decision = Schema.Union([
	Schema.TaggedStruct("Accept", { by: Schema.String, note: Schema.optionalKey(Schema.String) }),
	Schema.TaggedStruct("Correct", { by: Schema.String, correction: Schema.String }),
]);

/** What a person decides about a held answer. */
export type Decision = typeof Decision.Type;

/** The signal a held review task sleeps on: a person's decision. */
export const Released = Signal.make("review.release", 1, Decision);

/** The key the decision is delivered under. One per task is enough: every hold is a review task of its own. */
export const KEY = "release";

/** A person's decision about the held answer `answer`, and the harness clock when it ended the hold (`time`). */
export const Release = Schema.Struct({ answer: Entry.Id, decision: Decision, time: Schema.Number });

/** A person's decision about a held answer. */
export type Release = typeof Release.Type;

/** The entry kind a decision is stored as, in the commit that ends the hold. */
export const ReleaseEntry = Entry.make("review.release", Release);
