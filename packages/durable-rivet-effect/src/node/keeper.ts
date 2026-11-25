// A process beside this one that stops the engine of a directory when this process ends in any way: a kill leaves no
// time for a finalizer, and rivetkit ties the engine to its parent's end on Linux only.

import { spawn } from "node:child_process";
import { Effect, type Scope } from "effect";
import * as EngineProcess from "./engine-process.ts";

/** The watch over one start's engine. */
export interface Watch {
	/**
	 * Says which processes the engine is, once it is known. Until then the watcher stops whatever engine runs on the
	 * directory when this process ends; from then on these processes alone, so that an engine another process started
	 * on the directory since is not stopped with this process.
	 */
	readonly engines: (pids: ReadonlyArray<number>) => Effect.Effect<void>;
}

/**
 * Keeps watch over the engine of `directory` for the scope. The watcher is a shell that reads a pipe from this
 * process: the pipe ends when this process does, however it ends, and the shell then stops the engine, with the
 * terminate signal and after ten seconds with the kill signal. Closing the scope ends the watcher without stopping
 * anything: the engine is its starter's to stop then.
 *
 * Without a shell at `/bin/sh` nothing keeps watch, and the engine of a killed process is stopped by the next start
 * on its directory.
 */
export function keep(directory: string): Effect.Effect<Watch, never, Scope.Scope> {
	return Effect.map(
		Effect.acquireRelease(
			Effect.sync(() => {
				const watcher = spawn("/bin/sh", ["-c", SCRIPT], {
					env: { PATH: process.env.PATH, ENGINE_CONFIG: EngineProcess.config(directory) },
					stdio: ["pipe", "ignore", "ignore"],
					// A session of its own: a signal to this process's group, such as an interrupt from the terminal, is not its.
					detached: true,
				});
				// No shell: the spawn fails by this event, and nothing keeps watch. A pipe whose reader is gone fails a write.
				watcher.on("error", () => {});
				watcher.stdin.on("error", () => {});
				// Neither the watcher nor its pipe may keep a process alive that has nothing else to do.
				watcher.unref();
				// Feature detection: the pipe is a socket on Node.js and on Bun, which the type of `stdin` does not say.
				if ("unref" in watcher.stdin && typeof watcher.stdin.unref === "function") watcher.stdin.unref();
				return watcher;
			}),
			(watcher) =>
				Effect.sync(() => {
					// Killed before its pipe ends: the end of the pipe is what makes it stop engines.
					watcher.kill("SIGKILL");
					watcher.stdin.destroy();
				}),
		),
		(watcher) => ({
			// Done once the runtime took the line, or the watcher is gone. Bun says so before the line is in the pipe: a
			// process killed in that moment has said nothing, and its watcher stops every engine of the directory.
			engines: (pids) =>
				Effect.callback<void>((resume) => {
					watcher.stdin.write(`${pids.join(" ")}\n`, () => resume(Effect.void));
				}),
		}),
	);
}

// Each line of the pipe names the engine's processes, and the last one counts. Without a line the engines are the
// ones that run on the directory when the pipe ends: the configuration path comes by the environment, so that the
// shell's own command line does not name it and only an engine's does. rivetkit makes the engine the leader of a
// process group, which is signalled first, as `EngineProcess.stop` does.
const SCRIPT = `
trap "" INT TERM HUP
pids=""
while read -r line; do pids="$line"; done
[ -z "$pids" ] && pids=$(ps -axww -o pid=,command= | grep -F -- "--config $ENGINE_CONFIG" | grep -v -F "grep -F" | awk '{print $1}')
[ -z "$pids" ] && exit 0
left() { for pid in $pids; do kill -0 "$pid" 2>/dev/null && return 0; done; return 1; }
for pid in $pids; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; done
i=0
while [ $i -lt 20 ] && left; do sleep 0.5; i=$((i+1)); done
for pid in $pids; do kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; done
`;
