// The failures of Pi's environment contract as tagged errors: a file operation's and a command's.

import { Schema } from "effect";

/** Every code of Pi's `FileError`; the conformance check holds the list equal to Pi's `FileErrorCode`. */
export const FILE_ERROR_CODES = [
	"aborted",
	"not_found",
	"permission_denied",
	"not_directory",
	"is_directory",
	"invalid",
	"not_supported",
	"unknown",
] as const;

/** Every code of Pi's `ExecutionError`; the conformance check holds the list equal to Pi's `ExecutionErrorCode`. */
export const EXECUTION_ERROR_CODES = [
	"aborted",
	"timeout",
	"shell_unavailable",
	"spawn_error",
	"callback_error",
	"unknown",
] as const;

/**
 * A file operation of an environment failed (Pi's `FileError`). `aborted` means Pi stopped the operation on its own
 * side; interrupting the fiber interrupts the Effect instead.
 */
export class FileFailed extends Schema.TaggedError<FileFailed>()("FileFailed", {
	code: Schema.Literals(FILE_ERROR_CODES),
	message: Schema.String,
	path: Schema.optionalKey(Schema.String),
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * A command did not run to its exit (Pi's `ExecutionError`): a timeout, no shell, a failed spawn. A command that
 * exits with a non-zero code is not this error: its exit code is the result. `spillPath` holds the complete output
 * of a command that timed out after its output crossed the spill thresholds.
 */
export class ExecFailed extends Schema.TaggedError<ExecFailed>()("ExecFailed", {
	code: Schema.Literals(EXECUTION_ERROR_CODES),
	message: Schema.String,
	spillPath: Schema.optionalKey(Schema.String),
}) {}
