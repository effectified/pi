// The typed failures of this package: a reviewer that gave no usable answer, a citation the product's verifier could
// not check, a review task without an answer to review, a release for a conversation that is not held, and a retry
// for one whose review is not deferred.

import { ModelId, ProviderId } from "@effectified/pi-ai";
import { Conversation, Task } from "@effectified/pi-durable";
import { Predicate, Schema } from "effect";

/** The reviewer's request ended without an answer: the provider failed it, or it was aborted. */
export class ReviewerRequestFailed extends Schema.TaggedError<
	ReviewerRequestFailed,
	{ readonly brand: unique symbol }
>()("ReviewerRequestFailed", { provider: ProviderId, modelId: ModelId, reason: Schema.String }) {
	override get message(): string {
		return `The reviewer ${this.provider}/${this.modelId} did not answer: ${this.reason}`;
	}
}

/** The reviewer answered, but not with the findings object it was asked for. */
export class UndecodableReview extends Schema.TaggedError<UndecodableReview, { readonly brand: unique symbol }>()(
	"UndecodableReview",
	{ provider: ProviderId, modelId: ModelId, reason: Schema.String },
) {
	override get message(): string {
		return `The answer of the reviewer ${this.provider}/${this.modelId} is not a list of findings: ${this.reason}`;
	}
}

/**
 * The product's citation `Verifier` could not say whether a citation holds: what its port fails with. It says nothing
 * about the citation, so the citation check fails and the answer is recorded as not reviewed. The message is kept as
 * the check's failure in the verdict, so `reason` quotes nothing secret; `cause` is the product's own failure, for a
 * host.
 */
export class VerificationFailed extends Schema.TaggedError<VerificationFailed, { readonly brand: unique symbol }>()(
	"VerificationFailed",
	{ reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
	override get message(): string {
		return `The citation could not be verified: ${this.reason}`;
	}
}

/**
 * A review task found no answer to review: Pi's live run names none (`run.yield`), or the entry it names holds no
 * assistant message. The task then faults, and the answer has no verdict.
 */
export class NoAnswerUnderReview extends Schema.TaggedError<NoAnswerUnderReview, { readonly brand: unique symbol }>()(
	"NoAnswerUnderReview",
	{ conversationId: Conversation.Id, taskId: Task.Id },
) {
	override get message(): string {
		return `Review task ${this.taskId} found no answer under review in conversation ${this.conversationId}`;
	}
}

/** `release` was called for a conversation that is not held; `state` is the tag of the state it is in. */
export class NotHeld extends Schema.TaggedError<NotHeld, { readonly brand: unique symbol }>()("NotHeld", {
	conversationId: Conversation.Id,
	state: Schema.String,
}) {
	override get message(): string {
		return `Conversation ${this.conversationId} is not held: its review state is ${this.state}`;
	}
}

/** `retry` was called for a conversation whose review is not deferred; `state` is the tag of the state it is in. */
export class NotDeferred extends Schema.TaggedError<NotDeferred, { readonly brand: unique symbol }>()("NotDeferred", {
	conversationId: Conversation.Id,
	state: Schema.String,
}) {
	override get message(): string {
		return `The review of conversation ${this.conversationId} is not deferred: its review state is ${this.state}`;
	}
}

/** What a check or a request failed with, as the text a verdict keeps: an error's message, anything else as a string. */
export function describe(error: unknown): string {
	return Predicate.isError(error) ? error.message : String(error);
}
