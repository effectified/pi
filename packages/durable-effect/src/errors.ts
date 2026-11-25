// The typed failures of this package: what a Pi Durable call rejects with, as a closed union of tagged errors.

import {
	ConversationBusy as PiConversationBusy,
	ConversationIdle as PiConversationIdle,
	ReadAfterWrite as PiReadAfterWrite,
	ReadOnlySession as PiReadOnlySession,
	SessionFailed as PiSessionFailed,
	StorageRequestError as PiStorageRequestError,
} from "@earendil-works/pi-durable";
import { Predicate, Schema } from "effect";

/** A submission reached a busy conversation and was not admitted (`whenBusy: "reject"`, or a continue). */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
	conversationId: Schema.Number,
	message: Schema.String,
}) {}

/** An input with `whenIdle: "reject"` reached an idle conversation and was not admitted. */
export class ConversationIdle extends Schema.TaggedError<ConversationIdle>()("ConversationIdle", {
	conversationId: Schema.Number,
	message: Schema.String,
}) {}

/** A commit read a table, or admitted a submission, after its first table write. */
export class ReadAfterWrite extends Schema.TaggedError<ReadAfterWrite>()("ReadAfterWrite", {
	message: Schema.String,
}) {}

/** A read-only harness refused a write or a call that would run tasks; nothing was written. */
export class ReadOnlySession extends Schema.TaggedError<ReadOnlySession>()("ReadOnlySession", {
	message: Schema.String,
}) {}

/** The harness failed after a storage error and runs nothing any more; `cause` is that first error. Reopen it. */
export class SessionFailed extends Schema.TaggedError<SessionFailed>()("SessionFailed", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/** A storage read rejected an invalid request (an unknown conversation, a foreign cursor); only that read failed. */
export class StorageRequestError extends Schema.TaggedError<StorageRequestError>()("StorageRequestError", {
	message: Schema.String,
}) {}

/**
 * Pi Durable cancelled the call, and not because the calling fiber was interrupted (that interrupts the Effect
 * instead): the Chord context of the call was aborted from Pi's side. `cause` is the abort reason.
 */
export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return "Pi Durable cancelled the call";
	}
}

/** Pi Durable rejected with an error this package has no tag for, such as a `RangeError` of `configure()`. */
export class UnexpectedError extends Schema.TaggedError<UnexpectedError>()("UnexpectedError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/** Every failure of a call into Pi Durable. */
export type DurableError =
	| ConversationBusy
	| ConversationIdle
	| ReadAfterWrite
	| ReadOnlySession
	| SessionFailed
	| StorageRequestError
	| Cancelled
	| UnexpectedError;

/** What a Pi Durable promise rejected with, as a `DurableError`: the one place that reads Pi's error classes. */
export function fromRejection(cause: unknown): DurableError {
	if (cause instanceof PiConversationBusy) {
		return new ConversationBusy({ conversationId: cause.conversationId, message: cause.message });
	}
	if (cause instanceof PiConversationIdle) {
		return new ConversationIdle({ conversationId: cause.conversationId, message: cause.message });
	}
	if (cause instanceof PiReadAfterWrite) return new ReadAfterWrite({ message: cause.message });
	if (cause instanceof PiReadOnlySession) return new ReadOnlySession({ message: cause.message });
	if (cause instanceof PiSessionFailed) return new SessionFailed({ message: cause.message, cause: cause.cause });
	if (cause instanceof PiStorageRequestError) return new StorageRequestError({ message: cause.message });
	// Chord rejects a cancelled call with the signal's reason when it is an Error, else with an `AbortError`.
	if (Predicate.isError(cause) && cause.name === "AbortError") return new Cancelled({ cause });
	return new UnexpectedError({ cause });
}
