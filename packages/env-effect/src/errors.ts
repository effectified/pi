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
export class RemoteFailed extends Schema.TaggedError<RemoteFailed>()("RemoteFailed", {
	code: Schema.String,
	message: Schema.String,
	path: Schema.optionalKey(Schema.String),
	lost: Schema.Boolean,
}) {}

/** The host's key is not in the target's known-hosts file: scan it, have the owner compare it, then accept it. */
export class HostKeyUnknown extends Schema.TaggedError<HostKeyUnknown>()("HostKeyUnknown", {
	message: Schema.String,
}) {}

/** The host's key differs from the trusted one. It is never accepted on its own: forget the old key first. */
export class HostKeyChanged extends Schema.TaggedError<HostKeyChanged>()("HostKeyChanged", {
	message: Schema.String,
}) {}

/** An `ssh` run failed for another reason (no network, refused authentication, a timeout), with its diagnostics. */
export class SshFailed extends Schema.TaggedError<SshFailed>()("SshFailed", {
	message: Schema.String,
	exitCode: Schema.NullOr(Schema.Number),
	stderr: Schema.String,
}) {}

/**
 * Pi failed with an error that has no class of its own: an invalid SSH target field, an unsupported remote system,
 * a missing daemon binary, no host key received.
 */
export class UnexpectedError extends Schema.TaggedError<UnexpectedError>()("UnexpectedError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/** Every failure of this package. */
export type EnvError =
	| FileFailed
	| ExecFailed
	| RemoteFailed
	| HostKeyUnknown
	| HostKeyChanged
	| SshFailed
	| UnexpectedError;

/** What an `ssh` run fails with: the host-key errors, `ssh`'s own failure, and Pi's untyped errors. */
export type SshError = HostKeyUnknown | HostKeyChanged | SshFailed | UnexpectedError;

/** Pi's `FileError` as a `FileFailed`. */
export function fromFileError(error: FileError): FileFailed {
	return new FileFailed({
		code: error.code,
		message: error.message,
		...(error.path === undefined ? {} : { path: error.path }),
		...(error.cause === undefined ? {} : { cause: error.cause }),
	});
}

/** Pi's `ExecutionError` as an `ExecFailed`. */
export function fromExecutionError(error: ExecutionError): ExecFailed {
	return new ExecFailed({
		code: error.code,
		message: error.message,
		...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }),
	});
}
