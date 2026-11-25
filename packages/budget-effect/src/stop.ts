// A conversation the budget stopped: reading why from what Pi stored, and continuing it under a new lease.

import { type ConversationId, LiveDoc, type LiveState, type SubmissionId } from "@earendil-works/pi-durable";
import { type Conversation, type Doc, type DurableError, Harness, type Submission } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";
import { type Refusal, refusalOf } from "./refusal.ts";

/** A run the budget stopped: why, and the inputs it left unanswered. */
export interface Stop {
	/** `LeaseFenced` with the product's reason, `ShareExhausted` with the conversation's cap, or `PriceMissing`. */
	readonly refusal: Refusal;
	/** The submissions of the stopped run, each settled `unanswered` with reason `model_error`. */
	readonly inputs: ReadonlyArray<SubmissionId>;
}

/**
 * Why the conversation's newest run ended, when the budget ended it; none when it answered, when it ended for another
 * reason, and while a run is going on. Read from `pi.live`'s `runFailure`, which Pi stores in the commit that ends
 * the run, so it is the same after a restart. Pi removes it when the next run starts.
 */
export function stopOf(conversation: ConversationId): Effect.Effect<Option.Option<Stop>, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const live = yield* Harness.snapshot(LIVE, conversation);
		const failure = Option.getOrUndefined(live)?.runFailure;
		if (failure?.reason !== "model_error") return Option.none();
		const { inputs } = failure;
		return Option.map(yield* refusalOf(failure.detail), (refusal) => ({ refusal, inputs }));
	});
}

/**
 * Continues a conversation the budget stopped, once a lease covers it again: admits Pi's `continue`, a run on the
 * transcript as it is, which sends the refused request again. Nothing was lost: every entry up to the refused
 * request is there, and the inputs the stopped run left unanswered are answered by this run's answer in the
 * transcript, while their own records stay `unanswered`. Fails with `ConversationBusy` while a run is going on.
 */
export function continueStopped(
	conversation: Conversation.Conversation,
	options?: { readonly requestId?: string },
): Effect.Effect<Submission.Submission, DurableError> {
	return conversation.submit({ ...options, type: "continue" });
}

/**
 * Pi's built-in `pi.live` document as a document of the facade, which reads through Pi's own token. Nothing here
 * writes it, and Pi's type is the type of what Pi stored.
 */
const LIVE: Doc.Doc<Schema.Codec<LiveState, LiveState>, "conversation", "latest"> = {
	kind: LiveDoc.definition.kind,
	version: LiveDoc.definition.version,
	schema: Schema.declare((value: unknown): value is LiveState => typeof value === "object" && value !== null),
	scope: "conversation",
	history: "latest",
	family: false,
	token: LiveDoc,
	encode: (value) => Effect.succeed({ ...value }),
	decode: (stored) => Effect.succeed(stored as LiveState),
};
