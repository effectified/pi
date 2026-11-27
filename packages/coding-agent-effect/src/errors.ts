// The typed failures of this package: the one error class pi-coding-agent exports, the one its session runtime
// throws by name, and every other rejection of its promises, as one closed union of tagged errors.

import { CredentialSynchronizationError as PiCredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { ProviderId } from "@effectified/pi-ai";
import { Match, Predicate, Schema } from "effect";

/**
 * A credential change (`login`, `logout`, `setRuntimeApiKey`, `removeRuntimeApiKey`) was committed to the store, but
 * the model runtime could not update its own view of models and auth afterwards.
 */
export class CredentialSynchronizationError extends Schema.TaggedError<
	CredentialSynchronizationError,
	{ readonly brand: unique symbol }
>()("CredentialSynchronizationError", {
	providerId: ProviderId,
	operation: Schema.Literals(["login", "logout", "setRuntimeApiKey", "removeRuntimeApiKey"]),
	message: Schema.String,
}) {}

/** A session file given to import does not exist. */
export class SessionImportFileNotFound extends Schema.TaggedError<
	SessionImportFileNotFound,
	{ readonly brand: unique symbol }
>()("SessionImportFileNotFound", { message: Schema.String }) {}

/**
 * pi-coding-agent rejected with an error it has no class for: a prompt sent while the session streams without a
 * queueing choice, an invalid tool list, a model without credentials, a file that cannot be read. `message` is Pi's.
 */
export class CodingAgentError extends Schema.TaggedError<CodingAgentError, { readonly brand: unique symbol }>()(
	"CodingAgentError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Every failure of a call into pi-coding-agent, as one closed union: `CodingAgentFailure.match` picks a handler per
 * tag and `CodingAgentFailure.guards` tests for one.
 */
export const CodingAgentFailure = Schema.Union([
	CredentialSynchronizationError,
	SessionImportFileNotFound,
	CodingAgentError,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure of a call into pi-coding-agent. */
export type CodingAgentFailure = typeof CodingAgentFailure.Type;

/** The tagged failure for what pi-coding-agent rejected or threw with. */
export function fromPi(cause: unknown): CodingAgentFailure {
	return Match.value(cause).pipe(
		Match.when(Match.instanceOf(PiCredentialSynchronizationError), (error) =>
			CredentialSynchronizationError.make({
				providerId: ProviderId.make(error.providerId),
				operation: error.operation,
				message: error.message,
			}),
		),
		// The runtime's class is not exported from pi-coding-agent's root, so its name is what tells it apart.
		Match.when(
			(other: unknown): other is Error =>
				Predicate.isError(other) && other.name === "SessionImportFileNotFoundError",
			(error) => SessionImportFileNotFound.make({ message: error.message }),
		),
		Match.orElse((other) =>
			CodingAgentError.make({ message: Predicate.isError(other) ? other.message : String(other), cause: other }),
		),
	);
}
