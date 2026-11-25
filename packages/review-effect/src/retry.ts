// Reviewing again: the request that asks a deferred review task for another attempt at its answer.

import { type Conversation, Harness, type Signal } from "@gunta/pi-durable-effect";
import { Effect } from "effect";
import * as Deferral from "./deferral.ts";
import { NotDeferred } from "./errors.ts";
import { type Failure, state } from "./state.ts";

/** What `retry` did: the waiting task was asked to review again, or it had been asked already. */
export type Retrial = "retrying" | "already_retrying";

/**
 * Asks for the deferred review of `conversation`'s newest answer again, in one commit that stores the request with
 * the waiting review task. The task then wakes and reviews the same answer as the same pass: one new request to the
 * reviewer, every check again, each kept in a memo of its own, and a new verdict. What follows is the loop's own: a
 * pass settles the run's inputs, a blocking finding corrects the run or holds it, and a request that fails again
 * defers again. All of it happens after this Effect succeeded, once the harness schedules the task: `state` says
 * `InReview`, with the deferred verdict, until the new one is stored, and a second request meanwhile is
 * `already_retrying`. Fails with `NotDeferred` for a conversation whose review is not deferred.
 */
export function retry(
	conversation: Conversation.Conversation,
): Effect.Effect<Retrial, NotDeferred | Failure | Signal.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const current = yield* state(conversation);
		// Asked already, and the next verdict is not stored yet: the request stands.
		if (current._tag === "InReview" && current.verdict?.outcome._tag === "Deferred") return "already_retrying";
		if (current._tag !== "Deferred") {
			return yield* new NotDeferred({ conversationId: conversation.id, state: current._tag });
		}
		const { task, attempt } = current;
		// A commit that starts no scheduling, as `release` makes: a harness opened with `resume: false` takes it.
		switch (yield* Harness.commit((tx) => tx.signal(task, Deferral.Retried, Deferral.key(attempt), {}))) {
			case "delivered":
				return "retrying";
			case "duplicate":
				return "already_retrying";
			// The task ended between the two reads: the conversation was aborted meanwhile.
			case "closed":
			case "not_found":
			case "invalid":
				return yield* new NotDeferred({
					conversationId: conversation.id,
					state: (yield* state(conversation))._tag,
				});
		}
	});
}
