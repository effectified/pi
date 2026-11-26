// The typed failures of this package: what pi-codemode throws or rejects with, as one closed union of tagged errors.

import { Predicate, Schema } from "effect";

/**
 * A codemode source was refused (Pi's `CodemodeSourceError`): empty input, an options line that is not valid JSON, has
 * an unknown field, has no code after it, or is not the first line.
 */
export class CodemodeSourceError extends Schema.TaggedError<CodemodeSourceError>()("CodemodeSourceError", {
	message: Schema.String,
}) {}

/** The sandbox was used after its scope closed: Pi refuses new executions and runs of a closed sandbox. */
export class SandboxClosed extends Schema.TaggedError<SandboxClosed>()("SandboxClosed", {
	message: Schema.String,
}) {}

/**
 * Pi refused a tool or a global of a sandbox: a name registered twice, a global name that is not an identifier (or
 * `namespace.member`), shadows a built-in, or collides with a namespace.
 */
export class ToolRejected extends Schema.TaggedError<ToolRejected>()("ToolRejected", {
	message: Schema.String,
}) {}

/**
 * Pi refused to start a deterministic run: `startedAt` is not a non-negative number, `seed` is not a 32-bit unsigned
 * integer, or two declared tools share a name or a script name, or a declared global is invalid.
 */
export class RunRejected extends Schema.TaggedError<RunRejected>()("RunRejected", {
	message: Schema.String,
}) {}

/**
 * Pi refused an answer to a run's call: the call is not waiting for one, the result number is not a positive integer
 * used once, `now` is not finite, or a rejection's `properties` is not an object.
 */
export class DeliveryRejected extends Schema.TaggedError<DeliveryRejected>()("DeliveryRejected", {
	message: Schema.String,
}) {}

/** The QuickJS WebAssembly module could not be read or compiled. Pi retries the load on the next call. */
export class WasmLoadFailed extends Schema.TaggedError<WasmLoadFailed>()("WasmLoadFailed", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * Every failure of a call into pi-codemode. Pi has one error class (`CodemodeSourceError`) and otherwise throws plain
 * `Error`s; each it documents has a tag here, and anything else is a defect. A script that fails is no failure of the
 * Effect: Pi reports it in the result (`ok: false`, with the output and calls up to the failure).
 */
export type CodemodeFailure =
	| CodemodeSourceError
	| SandboxClosed
	| ToolRejected
	| RunRejected
	| DeliveryRejected
	| WasmLoadFailed;

/** The message of what Pi threw: an `Error`'s own, anything else as text. Pi's throws are of unknown type. */
export function messageOf(cause: unknown): string {
	return Predicate.isError(cause) ? cause.message : String(cause);
}
