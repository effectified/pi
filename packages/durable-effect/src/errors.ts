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
import * as Ids from "./id.ts";

/** A submission reached a busy conversation and was not admitted (`whenBusy: "reject"`, or a continue). */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
	conversationId: Ids.conversation,
	message: Schema.String,
}) {}

/** An input with `whenIdle: "reject"` reached an idle conversation and was not admitted. */
export class ConversationIdle extends Schema.TaggedError<ConversationIdle>()("ConversationIdle", {
	conversationId: Ids.conversation,
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
	for (const tag of TAGS) {
		const tagged = tag(cause);
		if (tagged !== undefined) return tagged;
	}
	// Chord rejects a cancelled call with the signal's reason when it is an Error, else with an `AbortError`.
	if (Predicate.isError(cause) && cause.name === "AbortError") return new Cancelled({ cause });
	return new UnexpectedError({ cause });
}

/**
 * The names of the Pi error classes `fromRejection` gives a tag of their own. The package's conformance check holds
 * them equal to the error classes Pi Durable exports, so a class Pi adds fails to compile until it has a tag here and
 * no Pi error becomes an `UnexpectedError` that a `catchTag` would miss.
 */
export type TaggedClass = keyof typeof BY_CLASS;

/** The tag of `cause` when it is an instance of one Pi error class, else nothing. */
type Tag = (cause: unknown) => DurableError | undefined;

// One entry per error class of Pi, keyed by the class's exported name.
const BY_CLASS = {
	ConversationBusy: tag(
		PiConversationBusy,
		(error) => new ConversationBusy({ conversationId: error.conversationId, message: error.message }),
	),
	ConversationIdle: tag(
		PiConversationIdle,
		(error) => new ConversationIdle({ conversationId: error.conversationId, message: error.message }),
	),
	ReadAfterWrite: tag(PiReadAfterWrite, (error) => new ReadAfterWrite({ message: error.message })),
	ReadOnlySession: tag(PiReadOnlySession, (error) => new ReadOnlySession({ message: error.message })),
	SessionFailed: tag(PiSessionFailed, (error) => new SessionFailed({ message: error.message, cause: error.cause })),
	StorageRequestError: tag(PiStorageRequestError, (error) => new StorageRequestError({ message: error.message })),
};

const TAGS: ReadonlyArray<Tag> = Object.values(BY_CLASS);

/** The tag `make` gives an instance of `piClass`. */
function tag<E extends Error>(piClass: abstract new (...args: never[]) => E, make: (error: E) => DurableError): Tag {
	return (cause) => (cause instanceof piClass ? make(cause) : undefined);
}
