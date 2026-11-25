// What an action answers across the actor boundary: its value, its own failure, or a defect, all as JSON data.

import { Cause, Predicate, Schema } from "effect";

/**
 * The answer of one action call. A Rivet action that throws reaches the caller as an opaque internal error, so an
 * action of this host never throws: every outcome is one of these three.
 */
export const Answer = Schema.Union([
	Schema.TaggedStruct("success", { value: Schema.Json }),
	Schema.TaggedStruct("failure", { error: Schema.Json }),
	Schema.TaggedStruct("defect", { message: Schema.String }),
]);

/** The answer of one action call. */
export type Answer = typeof Answer.Type;

/** The answer for a call that ended with `cause` and not with the action's own error. */
export function defect(cause: Cause.Cause<unknown>): Answer {
	if (Cause.hasInterruptsOnly(cause)) return { _tag: "defect", message: INTERRUPTED };
	const squashed = Cause.squash(cause);
	return { _tag: "defect", message: Predicate.isError(squashed) ? squashed.message : String(squashed) };
}

const INTERRUPTED = "The call was interrupted: the actor is stopping";
