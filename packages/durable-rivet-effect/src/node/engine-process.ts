// The engine process of one local engine, found by the data directory it was started on, and how it is stopped when
// rivetkit did not stop it.

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { Effect, Schedule } from "effect";

/**
 * The configuration file rivetkit starts the engine of `directory` with, which lies in the engine's data directory.
 * It is the argument an engine's process is found by, whole: `engines/org-1` is no engine of `engines/org-10`.
 */
export function config(directory: string): string {
	return join(resolve(directory), ".rivetkit", "var", "engine", "config.json");
}

/**
 * The process ids of the engines started on `directory`, by any process: rivetkit starts the engine with its
 * configuration file (`--config <directory>/.rivetkit/var/engine/config.json`), and a process that names that file
 * on its command line is an engine of the directory. Empty when the process list cannot be read. On Linux an engine
 * that ended and was not waited for yet has no command line, and is not listed.
 */
export function running(directory: string): Effect.Effect<ReadonlyArray<number>> {
	const argument = `--config ${config(directory)}`;
	return Effect.map(processes, (lines) =>
		lines.flatMap((line) => {
			const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
			return pid !== undefined && command?.includes(argument) ? [Number(pid)] : [];
		}),
	);
}

/**
 * Stops the engines started on `directory` and succeeds once none is left: the terminate signal first, and the kill
 * signal for one that is still there after a while. rivetkit stops its engine itself when a registry that became
 * ready shuts down; it leaves the engine of a start that failed or was interrupted, and the engine of a process that
 * was killed, which is what this is for.
 */
export function stop(directory: string): Effect.Effect<void> {
	return Effect.gen(function* () {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			const pids = yield* running(directory);
			if (pids.length === 0) return;
			yield* Effect.sync(() => {
				for (const pid of pids) send(pid, signal);
			});
			yield* Effect.timeoutOption(gone(directory), WAIT_MILLIS);
		}
	});
}

const WAIT_MILLIS = 5_000;

/** Succeeds once no engine of the directory is left. */
function gone(directory: string): Effect.Effect<void> {
	return Effect.asVoid(
		Effect.repeat(running(directory), {
			until: (pids) => pids.length === 0,
			schedule: Schedule.spaced("50 millis"),
		}),
	);
}

/** Every process as `<pid> <command line>`, from `ps`, which has the same options on macOS and Linux. */
const processes: Effect.Effect<ReadonlyArray<string>> = Effect.callback<ReadonlyArray<string>>((resume) => {
	execFile("ps", ["-axww", "-o", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
		resume(Effect.succeed(error === null ? stdout.split("\n") : [])),
	);
});

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
