// A conversation the budget stopped: reading why from what Pi stored, and continuing it under a new lease.

import type { ConversationId } from "@effectified/pi-durable";
import {
	BuiltinDoc,
	type Conversation,
	type Doc,
	type DurableError,
	Harness,
	Submission,
} from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import { Refusal, refusalOf } from "./refusal.ts";

/** A run the budget stopped: why, and the inputs it left unanswered. */
export const Stop = Schema.Struct({
	/** `LeaseFenced` with the product's reason, `ShareExhausted` with the conversation's cap, or `PriceMissing`. */
	refusal: Refusal,
	/** The submissions of the stopped run, each settled `unanswered` with reason `model_error`. */
	inputs: Schema.Array(Submission.Id),
});

/** A run the budget stopped. */
export type Stop = typeof Stop.Type;

/**
 * Why the conversation's newest run ended, when the budget ended it; none when it answered, when it ended for another
 * reason, and while a run is going on. Read from `pi.live`'s `runFailure`, which Pi stores in the commit that ends
 * the run, so it is the same after a restart. Pi removes it when the next run starts.
 */
export const stopOf: (
	conversation: ConversationId,
) => Effect.Effect<Option.Option<Stop>, Doc.Failure, Harness.Harness> = Effect.fn("Stop.stopOf")(
	function* (conversation) {
		const live = yield* Harness.snapshot(BuiltinDoc.live, conversation);
		const failure = Option.getOrUndefined(live)?.runFailure;
		if (failure?.reason !== "model_error") return Option.none();
		const { inputs } = failure;
		const refusal = yield* refusalOf(failure.detail);
		return Option.map(refusal, (found): Stop => ({ refusal: found, inputs }));
	},
);

/**
 * Continues a conversation the budget stopped, once a lease covers it again: admits Pi's `continue`, a run on the
 * transcript as it is, which sends the refused request again. Nothing was lost: every entry up to the refused
 * request is there, and the inputs the stopped run left unanswered are answered by this run's answer in the
 * transcript, while their own records stay `unanswered`. Fails with `ConversationBusy` while a run is going on.
 */
export const continueStopped: (
	conversation: Conversation.Conversation,
	options?: { readonly requestId?: string },
) => Effect.Effect<Submission.Submission, DurableError> = Effect.fn("Stop.continueStopped")(
	function* (conversation, options) {
		return yield* conversation.submit({ ...options, type: "continue" });
	},
);
