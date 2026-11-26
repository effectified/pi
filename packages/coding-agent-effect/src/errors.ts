// The typed failures of this package: the one error class pi-coding-agent exports, the one its session runtime
// throws by name, and every other rejection of its promises, as one closed union of tagged errors.

import { CredentialSynchronizationError as PiCredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { Predicate, Schema } from "effect";

/**
 * A credential change (`login`, `logout`, `setRuntimeApiKey`, `removeRuntimeApiKey`) was committed to the store, but
 * the model runtime could not update its own view of models and auth afterwards.
 */
export class CredentialSynchronizationError extends Schema.TaggedError<CredentialSynchronizationError>()(
	"CredentialSynchronizationError",
	{
		providerId: Schema.String,
		operation: Schema.Literals(["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"]),
		message: Schema.String,
	},
) {}

/** A session file given to import does not exist. */
export class SessionImportFileNotFound extends Schema.TaggedError<SessionImportFileNotFound>()(
	"SessionImportFileNotFound",
	{ message: Schema.String },
) {}

/**
 * pi-coding-agent rejected with an error it has no class for: a prompt sent while the session streams without a
 * queueing choice, an invalid tool list, a model without credentials, a file that cannot be read. `message` is Pi's.
 */
export class CodingAgentError extends Schema.TaggedError<CodingAgentError>()("CodingAgentError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** Every failure of a call into pi-coding-agent. */
export type CodingAgentFailure = CredentialSynchronizationError | SessionImportFileNotFound | CodingAgentError;

/** The tagged failure for what pi-coding-agent rejected or threw with. */
export function fromPi(cause: unknown): CodingAgentFailure {
	if (cause instanceof PiCredentialSynchronizationError) {
		return new CredentialSynchronizationError({
			providerId: cause.providerId,
			operation: cause.operation,
			message: cause.message,
		});
	}
	// The runtime's class is not exported from pi-coding-agent's root, so its name is what tells it apart.
	if (Predicate.isError(cause) && cause.name === "SessionImportFileNotFoundError") {
		return new SessionImportFileNotFound({ message: cause.message });
	}
	return new CodingAgentError({ message: Predicate.isError(cause) ? cause.message : String(cause), cause });
}
