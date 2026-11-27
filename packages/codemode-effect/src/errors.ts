// The typed failures of this package: what pi-codemode throws or rejects with, as one closed union of tagged errors,
// and the failure a worker's admission is denied with.

import { Predicate, Schema } from "effect";

/**
 * A codemode source was refused (Pi's `CodemodeSourceError`): empty input, an options line that is not valid JSON, has
 * an unknown field, has no code after it, or is not the first line. `cause` is Pi's error.
 */
export class CodemodeSourceError extends Schema.TaggedError<CodemodeSourceError, { readonly brand: unique symbol }>()(
	"CodemodeSourceError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** The sandbox was used after its scope closed: Pi refuses new executions and runs of a closed sandbox. */
export class SandboxClosed extends Schema.TaggedError<SandboxClosed, { readonly brand: unique symbol }>()(
	"SandboxClosed",
	{
		message: Schema.String,
	},
) {}

/**
 * Pi refused a tool or a global of a sandbox: a name registered twice, a global name that is not an identifier (or
 * `namespace.member`), shadows a built-in, or collides with a namespace. `cause` is what Pi threw.
 */
export class ToolRejected extends Schema.TaggedError<ToolRejected, { readonly brand: unique symbol }>()(
	"ToolRejected",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Pi refused to start a deterministic run: `startedAt` is not a non-negative number, `seed` is not a 32-bit unsigned
 * integer, or two declared tools share a name or a script name, or a declared global is invalid. `cause` is what Pi
 * threw.
 */
export class RunRejected extends Schema.TaggedError<RunRejected, { readonly brand: unique symbol }>()("RunRejected", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * Pi refused an answer to a run's call: the call is not waiting for one, the result number is not a positive integer
 * used once, `now` is not finite, or a rejection's `properties` is not an object. `cause` is what Pi threw.
 */
export class DeliveryRejected extends Schema.TaggedError<DeliveryRejected, { readonly brand: unique symbol }>()(
	"DeliveryRejected",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** The QuickJS WebAssembly module could not be read or compiled. Pi retries the load on the next call. */
export class WasmLoadFailed extends Schema.TaggedError<WasmLoadFailed, { readonly brand: unique symbol }>()(
	"WasmLoadFailed",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

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

/**
 * What a worker sandbox's `acquireWorker` fails with to deny a worker admission: the execution then ends with a
 * `sandbox` error whose message is `message`. Never a failure of an Effect of this package.
 */
export class AdmissionDenied extends Schema.TaggedError<AdmissionDenied, { readonly brand: unique symbol }>()(
	"AdmissionDenied",
	{
		message: Schema.String,
	},
) {}

/** The message of what Pi threw: an `Error`'s own, anything else as text. Pi's throws are of unknown type. */
export function messageOf(cause: unknown): string {
	return Predicate.isError(cause) ? cause.message : String(cause);
}
