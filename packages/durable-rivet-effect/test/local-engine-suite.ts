// Test helper: what a local engine start that fails or is interrupted leaves behind, registered once per runtime by
// local-engine.node.test.ts and local-engine.bun.test.ts. The failures are made with `RIVET_ENGINE_BINARY_PATH`,
// which rivetkit's engine resolver reads: a file that is no engine, and a stand-in that passes rivetkit's identity
// probe and then never listens. Skipped when the engine binary is not installed.
//
// The last test waits for the exit of the process that rivetkit makes about a minute after a start that got no
// healthy engine: without the exit guard the run ends there. Before it: an engine in a directory that is kept, two
// engines in one process, and what becomes of the engine of a host process of its own (local-engine-process.ts).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber, Schedule, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";
import * as ExitGuard from "../src/node/exit-guard.ts";
import * as Ports from "../src/node/ports.ts";
import type * as LocalEngine from "../src/node.ts";

const hostScript = new URL("./local-engine-process.ts", import.meta.url).pathname;

/** Registers the suite on the local engine of one runtime: `src/node.ts` or `src/bun.ts`. */
export function registerLocalEngineSuite(runtime: string, engines: typeof LocalEngine): void {
	const available = Effect.runSync(engines.available);
	describe.skipIf(!available)(`a local engine start that fails (${runtime})`, () => suite(engines));
}

/**
 * The temporary directories of local engines that exist now, where this process makes them. The suite gives its
 * process a temporary directory of its own for that (`TMPDIR`), because the test files of a run that go at the same
 * time have engines of their own, whose directories would be counted here.
 */
const directories = (): Array<string> => readdirSync(tmpdir()).filter((name) => name.startsWith("pi-durable-rivet-"));

/**
 * Whether the process runs. An engine is a child of this process that rivetkit's native core waits for: one that was
 * stopped stays in the process table, as a zombie, until the core gets to it, and is no running process.
 */
const alive = (pid: number): boolean => {
	try {
		const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return state !== "" && !state.startsWith("Z");
	} catch {
		// `ps` fails for a process id nothing has.
		return false;
	}
};

function suite(engines: typeof LocalEngine): void {
	let scripts = "";
	let interruptedAt = 0;
	let own = "";
	const shared = process.env.TMPDIR;

	beforeAll(() => {
		// Where this process's local engines keep their directories from here on, and the suite its scripts.
		own = mkdtempSync(join(tmpdir(), "pi-rivet-test-"));
		process.env.TMPDIR = own;
		scripts = join(own, "scripts");
		mkdirSync(scripts);
	});

	afterAll(() => {
		delete process.env.RIVET_ENGINE_BINARY_PATH;
		if (shared === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = shared;
		rmSync(own, { recursive: true, force: true });
	});

	/** Makes `body` the engine binary rivetkit starts, until `restore` is called. */
	const engineBinary = (name: string, body: string): (() => void) => {
		const path = join(scripts, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		process.env.RIVET_ENGINE_BINARY_PATH = path;
		return () => {
			delete process.env.RIVET_ENGINE_BINARY_PATH;
		};
	};

	it("fails with rivetkit's reason for a binary that is no engine, holds back rivetkit's exit, and leaves nothing", async () => {
		const exit = process.exit;
		const restore = engineBinary("no-engine.sh", "exit 3");
		try {
			const failed = await Effect.runPromise(Effect.flip(Effect.scoped(engines.serve({ actors: [] }))));
			expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "engine.incompatible_binary" });
			expect(failed.message).toContain("no-engine.sh");
		} finally {
			restore();
		}
		// rivetkit exited the process for this start at once, before the failure got here: the call was dropped, and
		// the guard is gone again.
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(0);
		expect(process.exit).toBe(exit);
		expect(directories()).toEqual([]);
	}, 30_000);

	it("stops the engine process of a start that was interrupted, and removes its directory", async () => {
		// The real engine answers rivetkit's identity probe; started as an engine, the stand-in never listens.
		const fromRivetkit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
		const real = (fromRivetkit("@rivetkit/engine-cli") as { readonly getEnginePath: () => string }).getEnginePath();
		const restore = engineBinary(
			"stalling-engine.sh",
			`case "$1" in\n--config) while :; do sleep 1; done ;;\n*) exec "${real}" "$@" ;;\nesac`,
		);
		try {
			const found = await Effect.runPromise(
				Effect.gen(function* () {
					const starting = yield* Effect.forkChild(Effect.scoped(engines.serve({ actors: [] })));
					// The engine the start spawned, by its process id, once rivetkit has started it.
					const spawned = yield* Effect.repeat(
						Effect.suspend(() => {
							const directory = process.env.RIVETKIT_STORAGE_PATH;
							return directory === undefined
								? Effect.succeed({ directory: "", pids: [] })
								: Effect.map(EngineProcess.running(directory), (pids) => ({ directory, pids }));
						}),
						{ until: ({ pids }) => pids.length > 0, schedule: Schedule.spaced("50 millis") },
					);
					const wasAlive = spawned.pids.map(alive);
					interruptedAt = Date.now();
					yield* Fiber.interrupt(starting);
					return { ...spawned, wasAlive };
				}),
			);
			expect(found.pids).toHaveLength(1);
			expect(found.wasAlive).toEqual([true]);
			// The interrupt returned once the start had cleaned up: the process is gone, and so is its directory.
			expect(found.pids.map(alive)).toEqual([false]);
			expect(existsSync(found.directory)).toBe(false);
		} finally {
			restore();
		}
		expect(directories()).toEqual([]);
		// rivetkit goes on asking the engine it lost for its health, and exits the process when it gives up.
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(1);
	}, 60_000);

	it("fails with `lost` when the engine's process ends during every start, and leaves nothing", async () => {
		// The stand-in answers rivetkit's identity probe as the real engine does; started as an engine, it ends at once,
		// as an engine does that another program on the machine stopped. rivetkit would ask it for its health for a minute.
		const fromRivetkit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
		const real = (fromRivetkit("@rivetkit/engine-cli") as { readonly getEnginePath: () => string }).getEnginePath();
		const restore = engineBinary(
			"ending-engine.sh",
			`case "$1" in\n--config) sleep 1; exit 0 ;;\n*) exec "${real}" "$@" ;;\nesac`,
		);
		const began = Date.now();
		try {
			const failed = await Effect.runPromise(Effect.flip(Effect.scoped(engines.serve({ actors: [] }))));
			expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "lost", retryable: true });
		} finally {
			restore();
		}
		// Every start of `serve` failed long before rivetkit's minute was over.
		expect(Date.now() - began).toBeLessThan(40_000);
		expect(directories()).toEqual([]);
	}, 60_000);

	it("serves again in the same process after the failed starts, and stops cleanly", async () => {
		const served = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const engine = yield* engines.serve({ actors: [], logging: { level: "error" } });
					const health = yield* Effect.promise(() => fetch(`${engine.endpoint}/health`));
					return { ...engine, status: health.status, pids: yield* engines.running(engine.directory) };
				}),
			),
		);
		expect(served.status).toBe(200);
		expect(served.pids).toHaveLength(1);
		expect(served.pids.map(alive)).toEqual([false]);
		expect(existsSync(served.directory)).toBe(false);
		expect(directories()).toEqual([]);
	}, 60_000);

	/** One run of an engine in `directory`: what it answered while it ran. */
	const servedIn = (directory: string, port?: number) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const engine = yield* engines.serve({
						actors: [],
						logging: { level: "error" },
						directory,
						...(port === undefined ? {} : { port }),
					});
					const health = yield* Effect.promise(() => fetch(`${engine.endpoint}/health`));
					return { engine, status: health.status, pids: yield* engines.running(directory) };
				}),
			),
		);

	it("keeps an engine's data in the directory it is given, on the port it is given, and starts there again", async () => {
		const directory = join(own, "kept", "engine");
		const port = await Effect.runPromise(Ports.free);
		const first = await servedIn(directory, port);
		expect(first.engine).toEqual({ endpoint: `http://127.0.0.1:${port}`, directory });
		expect(first.status).toBe(200);
		expect(first.pids).toHaveLength(1);
		// The scope closed: the engine is stopped, and what it wrote is where it was.
		expect(first.pids.map(alive)).toEqual([false]);
		expect(existsSync(join(directory, ".rivetkit", "var", "engine"))).toBe(true);
		const second = await servedIn(directory, port);
		expect(second.status).toBe(200);
		expect(second.pids).toHaveLength(1);
		expect(second.pids).not.toEqual(first.pids);
		expect(directories()).toEqual([]);
	}, 90_000);

	it("fails with the code port, and starts nothing, on a given port whose set something listens on", async () => {
		const directory = join(own, "port-taken");
		const blocker = await servedInBackground(join(own, "port-holder"));
		try {
			const port = Number(new URL(blocker.endpoint).port);
			const failed = await Effect.runPromise(
				Effect.flip(Effect.scoped(engines.serve({ actors: [], directory, port }))),
			);
			expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "port" });
			expect(await Effect.runPromise(engines.running(directory))).toEqual([]);
		} finally {
			await blocker.close();
		}
	}, 90_000);

	it("refuses the user's home as an engine's directory", async () => {
		const failed = await Effect.runPromise(
			Effect.flip(Effect.scoped(engines.serve({ actors: [], directory: join(homedir(), "x", "..") }))),
		);
		expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "environment", retryable: false });
	});

	it("runs two engines in one process, started at the same time, each in its own directory", async () => {
		const both = await Effect.runPromise(
			Effect.scoped(
				Effect.forEach(
					["two-a", "two-b"],
					(name) =>
						Effect.gen(function* () {
							const engine = yield* engines.serve({
								actors: [],
								logging: { level: "error" },
								directory: join(own, name),
							});
							const health = yield* Effect.promise(() => fetch(`${engine.endpoint}/health`));
							return { ...engine, status: health.status, pids: yield* engines.running(engine.directory) };
						}),
					{ concurrency: 2 },
				),
			),
		);
		expect(both.map((engine) => engine.status)).toEqual([200, 200]);
		expect(both.map((engine) => engine.directory)).toEqual([join(own, "two-a"), join(own, "two-b")]);
		expect(new Set(both.map((engine) => engine.endpoint)).size).toBe(2);
		expect(new Set(both.flatMap((engine) => engine.pids)).size).toBe(2);
		expect(both.flatMap((engine) => engine.pids).map(alive)).toEqual([false, false]);
	}, 90_000);

	/** A host process of its own that serves an engine in `directory`, once it has said which processes that is. */
	const hostOf = async (
		directory: string,
	): Promise<{ readonly host: ChildProcess; readonly pids: Array<number>; readonly ended: Promise<void> }> => {
		const host = spawn(process.execPath, ["--conditions=source", hostScript, directory], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const ended = new Promise<void>((resolve) => host.once("exit", () => resolve()));
		const pids = await new Promise<Array<number>>((resolve, reject) => {
			let said = "";
			host.stdout?.on("data", (chunk: Buffer) => {
				said += chunk.toString();
				const ready = /^ready (.*)$/m.exec(said);
				if (ready !== null) resolve((ready[1] ?? "").split(" ").map(Number));
			});
			host.once("exit", () => reject(new Error(`the host process ended before its engine was ready: ${said}`)));
		});
		return { host, pids, ended };
	};

	/** Waits until none of the processes runs, for at most `millis`. */
	const gone = async (pids: ReadonlyArray<number>, millis: number): Promise<boolean> => {
		const deadline = Date.now() + millis;
		while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		return !pids.some(alive);
	};

	it("leaves no engine when its host process is killed", async () => {
		const { host, pids } = await hostOf(join(own, "killed"));
		expect(pids).toHaveLength(1);
		expect(pids.map(alive)).toEqual([true]);
		host.kill("SIGKILL");
		expect(await gone(pids, 20_000)).toBe(true);
	}, 90_000);

	it("takes a directory over from a process that runs an engine on it, and keeps its own engine when that process ends", async () => {
		const directory = join(own, "taken");
		const before = await hostOf(directory);
		const mine = await servedInBackground(directory);
		try {
			// One engine per directory: the other process's was stopped before this one's was started.
			expect(before.pids.map(alive)).toEqual([false]);
			expect(mine.pids).toHaveLength(1);
			expect(mine.pids).not.toEqual(before.pids);
			// The other process ends, by rivetkit's exit for the engine it lost or by this kill, and its watcher acts.
			before.host.kill("SIGKILL");
			await before.ended;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			expect(mine.pids.map(alive)).toEqual([true]);
			expect((await fetch(`${mine.endpoint}/health`)).status).toBe(200);
		} finally {
			await mine.close();
		}
	}, 120_000);

	/** An engine in `directory` that runs until `close` is called. */
	const servedInBackground = async (
		directory: string,
	): Promise<{
		readonly endpoint: string;
		readonly pids: ReadonlyArray<number>;
		readonly close: () => Promise<void>;
	}> => {
		const scope = await Effect.runPromise(Scope.make());
		const engine = await Effect.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					const served = yield* engines.serve({ actors: [], logging: { level: "error" }, directory });
					return { endpoint: served.endpoint, pids: yield* engines.running(directory) };
				}),
				Scope.Scope,
				scope,
			),
		);
		return { ...engine, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
	};

	it("holds back the exit rivetkit makes a minute after the interrupted start", async () => {
		// The exit is dropped when it comes, and the hold ends with it. Were it not dropped, this run would end here.
		const deadline = interruptedAt + 90_000;
		while ((await Effect.runPromise(ExitGuard.waiting)) > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(await Effect.runPromise(ExitGuard.waiting)).toBe(0);
		// It came from rivetkit, not from the guard's own time limit, which is longer.
		expect(Date.now() - interruptedAt).toBeLessThan(ExitGuard.DOOM_MILLIS - 20_000);
		expect(directories()).toEqual([]);
	}, 100_000);
}
