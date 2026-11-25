// The engine process of one local engine, found by the data directory it was started on, and how it is stopped when
// rivetkit did not stop it.

import { execFile } from "node:child_process";
import { Effect, Schedule } from "effect";

/**
 * The process ids of the engines started on `directory`. rivetkit starts the engine with its configuration file,
 * which lies in the data directory (`--config <directory>/.rivetkit/var/engine/config.json`), and the directory is a
 * temporary one of this process's own making: a process that names it on its command line is an engine this
 * process started. Empty when the process list cannot be read.
 */
export function running(directory: string): Effect.Effect<ReadonlyArray<number>> {
	return Effect.map(processes, (lines) =>
		lines.flatMap((line) => {
			const [, pid, command] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
			return pid !== undefined && command?.includes(`--config ${directory}`) ? [Number(pid)] : [];
		}),
	);
}

/**
 * Stops the engines started on `directory` and succeeds once none is left: the terminate signal first, and the kill
 * signal for one that is still there after a while. rivetkit stops its engine itself when a registry that became
 * ready shuts down; it leaves the engine of a start that failed or was interrupted, which is what this is for.
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
