// The typed failures of this package: what an environment, a connection, `ssh` or a host-key change fails with, as
// one closed union of tagged errors.

import { ExecFailed, type ExecutionError, type FileError, FileFailed } from "@effectified/pi-durable/env";
import { Predicate, Schema } from "effect";

// The failures of the environment contract, which `@effectified/pi-durable/env` declares with it: this package's
// operations fail with them.
export { EXECUTION_ERROR_CODES, ExecFailed, FILE_ERROR_CODES, FileFailed } from "@effectified/pi-durable/env";

/**
 * The pi-env daemon refused a request, or the connection to it failed (Pi's `RemoteError`). `code` is the daemon's
 * Node-style code (`ENOENT`, `not_supported`, `spawn_error`, `aborted`, ...). `lost` is true when the connection was
 * lost or could not start, not refused: the same request may succeed once it starts again.
 */
export class RemoteFailed extends Schema.TaggedError<RemoteFailed, { readonly brand: unique symbol }>()(
	"RemoteFailed",
	{
		code: Schema.String,
		message: Schema.String,
		path: Schema.optionalKey(Schema.String),
		lost: Schema.Boolean,
	},
) {}

/** The host's key is not in the target's known-hosts file: scan it, have the owner compare it, then accept it. */
export class HostKeyUnknown extends Schema.TaggedError<HostKeyUnknown, { readonly brand: unique symbol }>()(
	"HostKeyUnknown",
	{ message: Schema.String },
) {}

/** The host's key differs from the trusted one. It is never accepted on its own: forget the old key first. */
export class HostKeyChanged extends Schema.TaggedError<HostKeyChanged, { readonly brand: unique symbol }>()(
	"HostKeyChanged",
	{ message: Schema.String },
) {}

/**
 * An `ssh` run failed for another reason (no network, refused authentication, a timeout), with its diagnostics.
 * `exitCode` is null when `ssh` did not exit on its own (a signal, a timeout).
 */
export class SshFailed extends Schema.TaggedError<SshFailed, { readonly brand: unique symbol }>()("SshFailed", {
	message: Schema.String,
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
}) {}

/**
 * Pi failed with an error that has no class of its own: an invalid SSH target field, an unsupported remote system,
 * a missing daemon binary, no host key received.
 */
export class UnexpectedError extends Schema.TaggedError<UnexpectedError, { readonly brand: unique symbol }>()(
	"UnexpectedError",
	{ cause: Schema.Defect() },
) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/**
 * What an `ssh` run fails with: the host-key errors, `ssh`'s own failure, and Pi's untyped errors. `SshError.match`
 * picks a handler per tag and `SshError.guards` tests for one.
 */
export const SshError = Schema.Union([HostKeyUnknown, HostKeyChanged, SshFailed, UnexpectedError]).pipe(
	Schema.toTaggedUnion("_tag"),
);

/** What an `ssh` run fails with. */
export type SshError = typeof SshError.Type;

/**
 * Every failure of this package, as one closed union: `EnvError.match` picks a handler per tag and `EnvError.guards`
 * tests for one.
 */
export const EnvError = Schema.Union([
	FileFailed,
	ExecFailed,
	RemoteFailed,
	HostKeyUnknown,
	HostKeyChanged,
	SshFailed,
	UnexpectedError,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure of this package. */
export type EnvError = typeof EnvError.Type;

/** Pi's `FileError` as a `FileFailed`. */
export function fromFileError(error: FileError): FileFailed {
	return FileFailed.make({
		code: error.code,
		message: error.message,
		...(error.path === undefined ? {} : { path: error.path }),
		...(error.cause === undefined ? {} : { cause: error.cause }),
	});
}

/** Pi's `ExecutionError` as an `ExecFailed`. */
export function fromExecutionError(error: ExecutionError): ExecFailed {
	return ExecFailed.make({
		code: error.code,
		message: error.message,
		...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }),
	});
}
