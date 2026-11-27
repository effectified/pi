// Commands of an environment: one run as an Effect of its exit, or as a Stream of its output that ends with its exit.

import type { ExecutionEnv, ShellExecOptions } from "@effectified/pi-durable/env";
import { Effect, Queue, Schema, Stream } from "effect";
import * as Call from "./call.ts";
import { type ExecFailed, fromExecutionError } from "./errors.ts";

/** Pi's options of a command, without the output callback: `execOutput` gives the output as a Stream. */
export type ExecOptions = Omit<ShellExecOptions, "onOutput">;

/** A command: a string runs through the environment's shell; an array runs its first element, the rest as arguments. */
export type Command = string | ReadonlyArray<string>;

/**
 * How a command that ran to its exit ended (Pi's `ShellExecResult`): its exit code, and the file holding its
 * complete output when it crossed the spill thresholds. A non-zero exit code is a result, not a failure.
 */
export const ExecResult = Schema.Struct({
	exitCode: Schema.Int,
	spillPath: Schema.optionalKey(Schema.String),
});

/** How a command that ran to its exit ended. */
export type ExecResult = typeof ExecResult.Type;

/** Output an environment omitted before a chunk, measured on the decoded text (Pi's `ShellOutputSkip`). */
const OutputSkip = Schema.Struct({
	bytes: Schema.Int,
	newlines: Schema.Int,
	endsWithNewline: Schema.Boolean,
});

/** A decoded chunk of stdout or stderr as it arrived, with the omission before it when the command has a `window`. */
const ExecOutput = Schema.Struct({
	kind: Schema.Literal("output"),
	text: Schema.String,
	stream: Schema.Literals(["stdout", "stderr"]),
	skipped: Schema.optionalKey(OutputSkip),
});

/** The command's exit, the last element of its output stream. */
const ExecExited = Schema.Struct({ kind: Schema.Literal("exited"), ...ExecResult.fields });

/**
 * One element of a command's output stream: its output chunks in arrival order, and last its exit.
 * `ExecEvent.match` picks a handler per `kind` and `ExecEvent.guards` tests for one.
 */
export const ExecEvent = Schema.Union([ExecOutput, ExecExited]).pipe(Schema.toTaggedUnion("kind"));

/** One element of a command's output stream. */
export type ExecEvent = typeof ExecEvent.Type;

/**
 * Runs `command` to its exit. A non-zero exit code is a result, not a failure. Interrupting the fiber kills the
 * command's processes and waits until they are gone.
 */
export function exec(
	env: ExecutionEnv,
	command: Command,
	options?: ExecOptions,
): Effect.Effect<ExecResult, ExecFailed> {
	return Call.result((context) => env.exec(command, options, context), fromExecutionError);
}

/**
 * Runs `command` as a Stream of its output, in arrival order, ending with its exit. The command starts when the
 * stream is run; ending the stream early (a `take`, an interruption) kills it.
 */
export function execOutput(
	env: ExecutionEnv,
	command: Command,
	options?: ExecOptions,
): Stream.Stream<ExecEvent, ExecFailed> {
	// The callback's buffer is unbounded: Pi's `onOutput` cannot wait, and a chunk must not be dropped before it is read.
	return Stream.callback<ExecEvent, ExecFailed>((queue) =>
		Call.result(
			(context) =>
				env.exec(
					command,
					{
						...options,
						onOutput: (text, _context, info) => Queue.offerUnsafe(queue, { kind: "output", text, ...info }),
					},
					context,
				),
			fromExecutionError,
		).pipe(
			Effect.andThen((result) => Queue.offer(queue, { kind: "exited", ...result })),
			Effect.andThen(Queue.end(queue)),
		),
	);
}
