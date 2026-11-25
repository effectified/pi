// Releasing a held conversation: a person's decision, delivered to the review task that waits for it, and the wait
// for the hold to end.

import { type Conversation, Harness, type Signal } from "@gunta/pi-durable-effect";
import { Effect } from "effect";
import { NotHeld } from "./errors.ts";
import * as Hold from "./hold.ts";
import { type Failure, type State, state } from "./state.ts";

/** What `release` did: the decision was stored for the waiting task, or an earlier one was and stands. */
export type Delivery = "released" | "already_released";

/**
 * Releases the held `conversation` with a person's `decision`, in one commit that stores it with the waiting review
 * task. The task then wakes, records the decision as a `review.release` entry and ends: with `Accept` the answer
 * stands and Pi settles the run's inputs `done`; with `Correct` the run continues with the correction as a user
 * message, and the next answer is reviewed again. Both happen after this Effect succeeded, once the harness
 * schedules the task: `state` says `Released` until then, and `waitForHoldEnd` waits for it. A second decision for
 * the same hold is `already_released`, and the first stands. Fails with `NotHeld` for a conversation that is not
 * held. Nothing checks who calls it: authenticate the person in the host.
 */
export function release(
	conversation: Conversation.Conversation,
	decision: Hold.Decision,
): Effect.Effect<Delivery, NotHeld | Failure | Signal.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const current = yield* state(conversation);
		if (current._tag === "Released") return "already_released";
		if (current._tag !== "Held") return yield* new NotHeld({ conversationId: conversation.id, state: current._tag });
		const { task } = current;
		// A commit of its own, as `Harness.signal` makes, but one that starts no scheduling: a harness opened with
		// `resume: false` takes the decision and runs nothing.
		switch (yield* Harness.commit((tx) => tx.signal(task, Hold.Released, Hold.KEY, decision))) {
			case "delivered":
				return "released";
			case "duplicate":
				return "already_released";
			// The task ended between the two reads: the conversation was aborted meanwhile.
			case "closed":
			case "not_found":
			case "invalid":
				return yield* new NotHeld({ conversationId: conversation.id, state: (yield* state(conversation))._tag });
		}
	});
}

/**
 * Waits until the hold of `conversation` has ended, and gives the state it then has: `Accepted` after an `Accept`,
 * `InReview` after a `Correct` (the run goes on), `NotReviewed` (`hold_ended`) after an abort. A conversation that
 * is neither `Held` nor `Released` gets its state at once. It waits for the review task of the hold to end, so a
 * hold nobody releases keeps it waiting, and so does a harness that schedules nothing (`resume: false`).
 * Interrupting it cancels only the wait.
 */
export function waitForHoldEnd(
	conversation: Conversation.Conversation,
): Effect.Effect<State, Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const current = yield* state(conversation);
		if (current._tag !== "Held" && current._tag !== "Released") return current;
		yield* Harness.waitForTask(current.task);
		return yield* state(conversation);
	});
}
