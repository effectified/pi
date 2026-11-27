// A program running in a pseudo-terminal of a pi-env daemon (a login shell), as a scoped resource.

import { openTerminal, type TerminalForeground, type TerminalOptions } from "@earendil-works/pi-env";
import { Effect, Option, type Scope, type Stream } from "effect";
import type { RemoteFailed } from "../errors.ts";
import type { Connection } from "./connection.ts";
import * as Program from "./program.ts";
import { remote } from "./rejection.ts";

/** Pi's options of a terminal, without the output callback: the terminal gives its output as a Stream. */
export type Options = Omit<TerminalOptions, "onData">;

/** A program in a pseudo-terminal: raw output, input, resizing and its exit code. */
export interface Terminal {
	readonly pid: number;
	/** The terminal's raw output in order, kept until read; ends when the program exits. Run it once. */
	readonly output: Stream.Stream<Uint8Array>;
	/** Sends input; once the terminal has ended, input is dropped. */
	readonly write: (data: Uint8Array | string) => Effect.Effect<void>;
	/** Changes the size; the program receives `SIGWINCH`. */
	readonly resize: (cols: number, rows: number) => Effect.Effect<void>;
	/**
	 * The job in the terminal's foreground when it is not the program itself (an editor a shell runs); none while
	 * the program is in front. Fails once the terminal has ended.
	 */
	readonly foreground: Effect.Effect<Option.Option<TerminalForeground>, RemoteFailed>;
	/** The exit code, an integer. Fails with the daemon's error, with code `aborted` once its scope closed. */
	readonly exited: Effect.Effect<number, RemoteFailed>;
}

/**
 * Starts a program, by default the user's login shell, in a new pseudo-terminal of the daemon behind `connection`;
 * closing the scope kills it and everything in its session. Not supported on Windows yet.
 */
export const open = Effect.fn("Terminal.open")(function* (
	connection: Connection,
	options: Options,
): Effect.fn.Return<Terminal, RemoteFailed, Scope.Scope> {
	const { pi, output, exited } = yield* Program.acquire(["output"], (write) =>
		openTerminal(connection.pi, { ...options, onData: (bytes) => write("output", bytes) }),
	);
	return {
		pid: pi.pid,
		output: output("output"),
		write: (data) => Effect.sync(() => pi.write(data)),
		resize: (cols, rows) => Effect.sync(() => pi.resize(cols, rows)),
		foreground: Effect.map(
			remote(() => pi.foreground()),
			Option.fromUndefinedOr,
		),
		exited,
	};
});
