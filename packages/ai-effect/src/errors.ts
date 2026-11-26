// The typed failures of this package: a model that is not registered, a request that pi-ai ended in an error, and
// the failures of pi-ai's auth, credential, JSON, tool-validation and session-cleanup operations.

import type { AssistantMessage, ModelsErrorCode } from "@earendil-works/pi-ai";
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

/**
 * An auth operation of `Models` failed (`getAuth`, `checkAuth`, `getAvailable`, `login`, `logout`). `reason` is the
 * code of pi-ai's `ModelsError`: `provider` (no such provider), `auth` (the provider has no such login, the API key
 * could not be resolved, or the credential store failed) or `oauth` (refreshing the token failed; the stored
 * credential is kept, and logging in again fixes it). `login` is the provider's own login flow failing (denied,
 * expired, a malformed answer of the authorization server). `message` is pi-ai's.
 */
export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
	reason: Schema.Literals(["model_source", "model_validation", "provider", "stream", "auth", "oauth", "login"]),
	message: Schema.String,
}) {}

/** The reasons of `AuthError`: pi-ai's `ModelsError` codes, and `login`. */
export type AuthErrorReason = ModelsErrorCode | "login";

/** A credential store could not read, list, write or delete. `message` says why. */
export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()("CredentialStoreError", {
	providerId: Schema.UndefinedOr(Schema.String),
	message: Schema.String,
}) {}

/** Text a model sent is not JSON, even after pi-ai's repair. `message` is the parser's. */
export class MalformedJson extends Schema.TaggedError<MalformedJson>()("MalformedJson", {
	text: Schema.String,
	message: Schema.String,
}) {}

/**
 * A tool call pi-ai's validation rejects: no tool has its name, its arguments were malformed JSON, or they do not
 * match the tool's JSON Schema. `message` is pi-ai's, written for the model to read and correct the call.
 */
export class InvalidToolCall extends Schema.TaggedError<InvalidToolCall>()("InvalidToolCall", {
	toolName: Schema.String,
	message: Schema.String,
}) {}

/** One or more of the cleanups registered with pi-ai's session resources threw. `messages` are theirs. */
export class SessionCleanupError extends Schema.TaggedError<SessionCleanupError>()("SessionCleanupError", {
	messages: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `Failed to clean up session resources: ${this.messages.join("; ")}`;
	}
}
