// The typed failures of this package: what a wrapped Chord function throws or rejects with, as one closed union.

import { ChordError as PiChordError, PluginError as PiPluginError } from "@earendil-works/chord";
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

/** Chord's error codes; `test/pi-conformance.ts` checks that these are all of them. */
export const CHORD_ERROR_CODES = [
	"invalid",
	"contract_mismatch",
	"forbidden",
	"gone",
	"not_ready",
	"released",
	"too_large",
	"unavailable",
	"aborted",
] as const;

/** Chord's error reasons, of every code; `test/pi-conformance.ts` checks that these are all of them. */
export const CHORD_ERROR_REASONS = [
	"args",
	"params",
	"member",
	"host_address",
	"reentrant",
	"read_after_bulk",
	"cycle",
	"updating",
	"revoked",
	"ended",
	"closed",
	"settled",
	"version",
	"discarded",
	"part",
	"locked",
	"park_timeout",
	"busy",
	"storage_failed",
	"undeclared",
	"reload_cycle",
] as const;

/**
 * A Chord call failed with Chord's `ChordError`: its code (`invalid`, `released`, `unavailable`, ...), the reason that
 * narrows it, its message and the JSON details some codes carry. The error a facet's method declares (`invalid`,
 * `forbidden`) reaches its caller as this.
 */
export class ChordFailed extends Schema.TaggedError<ChordFailed>()("ChordFailed", {
	code: Schema.Literals(CHORD_ERROR_CODES),
	reason: Schema.optional(Schema.Literals(CHORD_ERROR_REASONS)),
	message: Schema.String,
	details: Schema.optional(Schema.Json),
}) {}

/** A plugin's own error (Chord's `PluginError`): the code the plugin gave it, its message and details. */
export class PluginFailed extends Schema.TaggedError<PluginFailed>()("PluginFailed", {
	code: Schema.String,
	message: Schema.String,
	details: Schema.optional(Schema.Json),
}) {}

/** The failures of a Chord runtime call: Chord's two error classes. */
export type ChordCallError = ChordFailed | PluginFailed;

/** The error classes of Chord's root; `test/pi-conformance.ts` checks that these are all of them. */
export type ChordErrorClass = "ChordError" | "PluginError";

/** What a Chord call threw or rejected with, as its tagged error: one entry per error class of Chord's root. */
const FROM_CHORD = {
	ChordError: (thrown) =>
		thrown instanceof PiChordError
			? new ChordFailed({
					code: thrown.code,
					message: thrown.message,
					...(thrown.reason === undefined ? {} : { reason: thrown.reason }),
					...(thrown.details === undefined ? {} : { details: thrown.details }),
				})
			: undefined,
	PluginError: (thrown) =>
		thrown instanceof PiPluginError
			? new PluginFailed({
					code: thrown.code,
					message: thrown.message,
					...(thrown.details === undefined ? {} : { details: thrown.details }),
				})
			: undefined,
} satisfies Record<ChordErrorClass, (thrown: unknown) => ChordCallError | undefined>;

/**
 * What a Chord runtime call threw or rejected with, as its `ChordCallError`; `undefined` for anything else (a
 * database's own error, a bug), which the caller decides on.
 */
export function fromChord(thrown: unknown): ChordCallError | undefined {
	return FROM_CHORD.ChordError(thrown) ?? FROM_CHORD.PluginError(thrown);
}

/** The failures of a delta function on its data. */
export type DeltaError = PathError | UnsafePathError | InvalidOp;

/** Every failure of this package. */
export type ChordFailure = DeltaError | NotJson | InvalidSchemaPrefix | SqliteError | ChordCallError;

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
