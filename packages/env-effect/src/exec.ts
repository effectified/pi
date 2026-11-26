// Commands of an environment: one run as an Effect of its exit, or as a Stream of its output that ends with its exit.

import type { ExecutionEnv, ShellExecOptions, ShellExecResult, ShellOutputInfo } from "@effectified/pi-durable/env";
import { Effect, Queue, Stream } from "effect";
import * as Call from "./call.ts";
import { type ExecFailed, fromExecutionError } from "./errors.ts";

/** Pi's options of a command, without the output callback: `execOutput` gives the output as a Stream. */
export type ExecOptions = Omit<ShellExecOptions, "onOutput">;

/** A command: a string runs through the environment's shell; an array runs its first element, the rest as arguments. */
export type Command = string | ReadonlyArray<string>;

/**
 * One element of a command's output stream: a decoded chunk of stdout or stderr as it arrived (with the omission
 * before it, with `window`), and last the exit.
 */
export type ExecEvent =
	| ({ readonly kind: "output"; readonly text: string } & Readonly<ShellOutputInfo>)
	| ({ readonly kind: "exited" } & Readonly<ShellExecResult>);

/**
 * Runs `command` to its exit. A non-zero exit code is a result, not a failure. Interrupting the fiber kills the
 * command's processes and waits until they are gone.
 */
export function exec(
	env: ExecutionEnv,
	command: Command,
	options?: ExecOptions,
): Effect.Effect<ShellExecResult, ExecFailed> {
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
