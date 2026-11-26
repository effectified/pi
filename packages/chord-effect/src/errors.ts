// The typed failures of this package: what a wrapped Chord function throws or rejects with, as one closed union.

import { PathError as PiPathError, UnsafePathError as PiUnsafePathError } from "@earendil-works/chord/delta";
import { Predicate, Schema } from "effect";

/** One segment of a Chord delta path: an object key or an array index. */
const Segment = Schema.Union([Schema.String, Schema.Number]);

/** A delta op names a path that does not resolve in the value it is applied to; `path` is that path, or its wire id. */
export class PathError extends Schema.TaggedError<PathError>()("PathError", {
	path: Schema.Union([Schema.Array(Segment), Schema.Number]),
	message: Schema.String,
}) {}

/**
 * A delta path has a segment that would reach the prototype chain (`__proto__`, `constructor`, `prototype`), an index
 * that is not a non-negative integer, or an index past the end of its array; nothing was written.
 */
export class UnsafePathError extends Schema.TaggedError<UnsafePathError>()("UnsafePathError", {
	segment: Segment,
	message: Schema.String,
}) {}

/** A value is not a Chord delta op (`Op`, or `WireOp` on the wire): its verb, arity or payload is wrong. */
export class InvalidOp extends Schema.TaggedError<InvalidOp>()("InvalidOp", {
	message: Schema.String,
}) {}

/** A value is not strict JSON: a non-finite number, a cycle, a non-plain object, a symbol key, an accessor. */
export class NotJson extends Schema.TaggedError<NotJson>()("NotJson", {
	message: Schema.String,
}) {}

/** A name is not usable as a SQLite schema prefix: not an identifier, or reserved by SQLite (`sqlite_`). */
export class InvalidSchemaPrefix extends Schema.TaggedError<InvalidSchemaPrefix>()("InvalidSchemaPrefix", {
	prefix: Schema.String,
	message: Schema.String,
}) {}

/** A SQLite database, or Chord's migrations on it, rejected; `cause` is what it rejected with. */
export class SqliteError extends Schema.TaggedError<SqliteError>()("SqliteError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/** The failures of a delta function on its data. */
export type DeltaError = PathError | UnsafePathError | InvalidOp;

/** Every failure of this package. */
export type ChordFailure = DeltaError | NotJson | InvalidSchemaPrefix | SqliteError;

/** The error classes Chord's delta exports; `test/pi-conformance.ts` checks that these are all of them. */
export type DeltaErrorClass = "PathError" | "UnsafePathError";

/** What delta threw, as its tagged error: one entry per error class of Chord's delta. */
const FROM_DELTA = {
	PathError: (thrown) =>
		thrown instanceof PiPathError ? new PathError({ path: thrown.path, message: thrown.message }) : undefined,
	UnsafePathError: (thrown) =>
		thrown instanceof PiUnsafePathError
			? new UnsafePathError({ segment: thrown.segment, message: thrown.message })
			: undefined,
} satisfies Record<DeltaErrorClass, (thrown: unknown) => DeltaError | undefined>;

/**
 * What a delta function threw on its data, as its `DeltaError`: Chord's two path errors, and the `TypeError` its op
 * validators throw as `InvalidOp`. `undefined` for anything else, which delta does not throw on data: a defect.
 */
export function fromDelta(thrown: unknown): DeltaError | undefined {
	const tagged = FROM_DELTA.PathError(thrown) ?? FROM_DELTA.UnsafePathError(thrown);
	if (tagged !== undefined) return tagged;
	return thrown instanceof TypeError ? new InvalidOp({ message: thrown.message }) : undefined;
}
