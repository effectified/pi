// The engine process of one local engine, found by the data directory it was started on, and how it is stopped when
// rivetkit did not stop it.

import { join, resolve } from "node:path";
import { Array as Arr, Effect, Schedule, String as Str } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EngineUnavailable } from "../errors.ts";

/**
 * The configuration file rivetkit starts the engine of `directory` with, which lies in the engine's data directory.
 * It is the argument an engine's process is found by, whole: `engines/org-1` is no engine of `engines/org-10`. A pure
 * function on Node's `path`, resolved against the working directory, so the watcher's start needs no service for it.
 */
export function config(directory: string): string {
	return join(resolve(directory), ".rivetkit", "var", "engine", "config.json");
}

/**
 * The process ids of the engines started on `directory`, by any process: rivetkit starts the engine with its
 * configuration file (`--config <directory>/.rivetkit/var/engine/config.json`), and a process that names that file
 * on its command line is an engine of the directory. On Linux an engine that ended and was not waited for yet has no
 * command line, and is not listed. Fails with the code `environment` when the process list cannot be read.
 */
export const running: (
	directory: string,
) => Effect.Effect<ReadonlyArray<number>, EngineUnavailable, ChildProcessSpawner.ChildProcessSpawner> =
	// Untraced: it is asked every few hundred milliseconds while an engine starts or stops.
	Effect.fnUntraced(function* (directory: string) {
		const argument = `--config ${config(directory)}`;
		const lines = yield* processes;
		return Arr.flatMap(lines, (line) => {
			const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
			return pid !== undefined && command !== undefined && Str.includes(argument)(command) ? [Number(pid)] : [];
		});
	});

/**
 * Stops the engines started on `directory` and succeeds once none is left: the terminate signal first, and the kill
 * signal for one that is still there after a while. rivetkit stops its engine itself when a registry that became
 * ready shuts down; it leaves the engine of a start that failed or was interrupted, and the engine of a process that
 * was killed, which is what this is for. Fails as `running` does.
 */
export const stop: (
	directory: string,
) => Effect.Effect<void, EngineUnavailable, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("EngineProcess.stop")(
	function* (directory: string) {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			const pids = yield* running(directory);
			if (pids.length === 0) return;
			yield* Effect.sync(() => {
				for (const pid of pids) send(pid, signal);
			});
			yield* Effect.timeoutOption(gone(directory), WAIT_MILLIS);
		}
	},
);

const WAIT_MILLIS = 5_000;

/** Succeeds once no engine of the directory is left. */
function gone(directory: string): Effect.Effect<void, EngineUnavailable, ChildProcessSpawner.ChildProcessSpawner> {
	return Effect.asVoid(
		Effect.repeat(running(directory), {
			until: (pids) => pids.length === 0,
			schedule: Schedule.spaced("50 millis"),
		}),
	);
}

/** Every process as `<pid> <command line>`, from `ps`, which has the same options on macOS and Linux. */
const processes = ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
	Effect.mapError(spawner.lines(ChildProcess.make("ps", ["-axww", "-o", "pid=,command="])), (error) =>
		EngineUnavailable.make({
			code: "environment",
			message: `The process list could not be read with ps, so no engine process can be found: ${error.message}`,
			retryable: false,
		}),
	),
);

/**
 * Signals the engine and what it started: rivetkit makes the engine the leader of a process group of its own. A
 * process that is gone already, or that leads no group, is not an error.
 */
function send(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, signal);
			return;
		} catch {
			// No such group or process: the next target, or nothing left to signal.
		}
	}
}
