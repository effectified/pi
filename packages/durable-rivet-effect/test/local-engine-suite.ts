// Test helper: what a local engine start that fails or is interrupted leaves behind, registered once per runtime by
// local-engine.node.test.ts and local-engine.bun.test.ts. The failures are made with `RIVET_ENGINE_BINARY_PATH`,
// which rivetkit's engine resolver reads: a file that is no engine, and a stand-in that passes rivetkit's identity
// probe and then never listens. Skipped when the engine binary is not installed.
//
// The last test waits for the exit of the process that rivetkit makes about a minute after a start that got no
// healthy engine: without the exit guard the run ends there.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Schedule } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";
import * as ExitGuard from "../src/node/exit-guard.ts";
import type * as LocalEngine from "../src/node.ts";

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
		expect(process.env.RIVETKIT_STORAGE_PATH).toBeUndefined();
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
		expect(process.env.RIVETKIT_STORAGE_PATH).toBeUndefined();
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
		expect(process.env.RIVETKIT_STORAGE_PATH).toBeUndefined();
		expect(directories()).toEqual([]);
	}, 60_000);

	it("serves again in the same process after the failed starts, and stops cleanly", async () => {
		const served = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const engine = yield* engines.serve({ actors: [], logging: { level: "error" } });
					const directory = process.env.RIVETKIT_STORAGE_PATH ?? "";
					const health = yield* Effect.promise(() => fetch(`${engine.endpoint}/health`));
					return { directory, status: health.status, pids: yield* EngineProcess.running(directory) };
				}),
			),
		);
		expect(served.status).toBe(200);
		expect(served.pids).toHaveLength(1);
		expect(served.pids.map(alive)).toEqual([false]);
		expect(existsSync(served.directory)).toBe(false);
		expect(directories()).toEqual([]);
	}, 60_000);

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
