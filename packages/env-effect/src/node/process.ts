// A program running with plain pipes in a pi-env daemon (an MCP server, a language server), as a scoped resource.

import { openProcess, type ProcessOptions } from "@earendil-works/pi-env";
import { Effect, type Scope, type Stream } from "effect";
import type { RemoteFailed } from "../errors.ts";
import type { Connection } from "./connection.ts";
import * as Program from "./program.ts";

/** Pi's options of a process, without the output callbacks: the process gives its output as Streams. */
export type Options = Omit<ProcessOptions, "onStdout" | "onStderr">;

/**
 * A program running with plain pipes. Nothing is echoed, translated or merged. When it exits, the daemon kills what
 * it started in its process group, so a wrapper such as `npx` leaves nothing running.
 */
export interface Process {
	readonly pid: number;
	/** Its stdout, raw bytes in order, kept until read; ends when it exits. Run it once. */
	readonly stdout: Stream.Stream<Uint8Array>;
	/** Its stderr, raw bytes in order, kept until read; ends when it exits. Run it once. */
	readonly stderr: Stream.Stream<Uint8Array>;
	/** Writes to its stdin, in order; once stdin is closed or it has ended, input is dropped. */
	readonly write: (data: Uint8Array | string) => Effect.Effect<void>;
	/** Closes its stdin after what was written before. */
	readonly closeStdin: Effect.Effect<void>;
	/** Its exit code, an integer. Fails with the daemon's error, with code `aborted` once its scope closed. */
	readonly exited: Effect.Effect<number, RemoteFailed>;
}

/**
 * Starts a program in the daemon behind `connection`; closing the scope kills it and its process group. Fails with
 * `not_supported` when the daemon predates processes.
 */
export const open = Effect.fn("Process.open")(function* (
	connection: Connection,
	options: Options,
): Effect.fn.Return<Process, RemoteFailed, Scope.Scope> {
	const { pi, output, exited } = yield* Program.acquire(["stdout", "stderr"], (write) =>
		openProcess(connection.pi, {
			...options,
			onStdout: (bytes) => write("stdout", bytes),
			onStderr: (bytes) => write("stderr", bytes),
		}),
	);
	return {
		pid: pi.pid,
		stdout: output("stdout"),
		stderr: output("stderr"),
		write: (data) => Effect.sync(() => pi.write(data)),
		closeStdin: Effect.sync(() => pi.closeStdin()),
		exited,
	};
});
