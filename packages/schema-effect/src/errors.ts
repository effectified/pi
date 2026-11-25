// The typed failures of this package: a value a schema rejects, and a schema that cannot be converted.

import { Schema } from "effect";

/** One reason a value was rejected: where (a JSON Pointer, "" for the value itself) and why. */
export const Issue = Schema.Struct({
	path: Schema.String,
	message: Schema.String,
	/** The failing JSON Schema keyword; only pi-schema validators report one. */
	keyword: Schema.optional(Schema.String),
});

/** One reason a value was rejected. */
export type Issue = typeof Issue.Type;

/** A value did not match its schema; `issues` is never empty. */
export class SchemaDecodeError extends Schema.TaggedError<SchemaDecodeError>()("SchemaDecodeError", {
	issues: Schema.Array(Issue),
}) {
	override get message(): string {
		return this.issues
			.map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
			.join("; ");
	}
}

/** A schema could not be converted or compiled: an unsupported keyword, a dangling `$ref`, a malformed schema. */
export class SchemaConversionError extends Schema.TaggedError<SchemaConversionError>()("SchemaConversionError", {
	reason: Schema.String,
}) {
	override get message(): string {
		return this.reason;
	}
}
