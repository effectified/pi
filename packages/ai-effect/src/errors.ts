// The typed failures of this package: a model that is not registered, and a request that pi-ai ended in an error.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Predicate, Schema } from "effect";

/** No registered provider lists a chat model with this id. */
export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()("ModelNotFound", {
	provider: Schema.String,
	modelId: Schema.String,
}) {
	override get message(): string {
		return `No chat model "${this.modelId}" is registered for provider "${this.provider}"`;
	}
}

/**
 * A request ended in pi-ai's `error` event. `response` is the assistant message of that event: the content received
 * before the failure, its usage, and `errorMessage`. `reason` is `"aborted"` when the provider gave the request up
 * (a timeout, a closed connection); interrupting the fiber is interruption and never this error.
 */
export class ModelRequestError extends Schema.TaggedError<ModelRequestError>()("ModelRequestError", {
	reason: Schema.Literals(["error", "aborted"]),
	// pi-ai has no schema for its messages; the role is what tells an assistant message from the other kinds.
	response: Schema.declare(
		(value: unknown): value is AssistantMessage => Predicate.isObject(value) && value.role === "assistant",
	),
}) {
	override get message(): string {
		return this.response.errorMessage ?? `The request ended with stop reason "${this.reason}"`;
	}
}
