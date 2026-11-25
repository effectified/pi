// The typed failures of this package: a decision made for other arguments, and stored state that does not decode.

import { Schema } from "effect";

/**
 * `decide` got a decision whose digest is not the request's: it was made for other arguments than the request holds.
 * Nothing was delivered.
 */
export class DigestMismatch extends Schema.TaggedError<DigestMismatch>()("DigestMismatch", {
	/** The id of the request the decision was sent to. */
	request: Schema.String,
	/** The digest of that request's arguments. */
	expected: Schema.String,
	/** The digest the decision names. */
	actual: Schema.String,
}) {
	override get message(): string {
		return `The decision names the digest ${this.actual}, but the request ${this.request} has ${this.expected}`;
	}
}

/**
 * Something this package stored does not decode: a request in a task memo, a record in a tool result's details, or a
 * decision Pi refuses. Written by another version of the package, or by something else under the same name.
 */
export class MalformedState extends Schema.TaggedError<MalformedState>()("MalformedState", {
	/** What was read: a memo name, `details.approvals`, or `decision`. */
	where: Schema.String,
	reason: Schema.String,
}) {
	override get message(): string {
		return `${this.where}: ${this.reason}`;
	}
}
