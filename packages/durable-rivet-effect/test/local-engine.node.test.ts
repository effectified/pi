// The Node lane's local engine: the failure suite both runtimes share, and what needs a start on a port the test
// chose, which goes past the entry (`node/local-engine.ts`) with Node's own environment.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";
import * as Local from "../src/node/local-engine.ts";
import * as Ports from "../src/node/ports.ts";
import * as LocalEngine from "../src/node.ts";
import { registerLocalEngineSuite } from "./local-engine-suite.ts";

// Bun runs this file too, since its runner takes every test file: there the Node entry refuses to start an engine.
const onNode = !("Bun" in globalThis);

if (onNode) registerLocalEngineSuite("Node.js", LocalEngine);

/** On Node.js `process.env` is the process's environment itself: what `src/node.ts` gives the local engine. */
const environment: Local.Environment = {
	set: (name, value) =>
		Effect.sync(() => {
			process.env[name] = value;
		}),
	unset: (name) =>
		Effect.sync(() => {
			delete process.env[name];
		}),
};

const listen = (port: number): Promise<Server> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const available = onNode && Effect.runSync(LocalEngine.available);

describe.skipIf(!available)("a local engine start on a set with a taken port (Node.js)", () => {
	it("fails with the code port as soon as the engine reports it, long before rivetkit gives up, and leaves nothing", async () => {
		const port = await Effect.runPromise(Ports.free);
		// The engine's second port, taken between the check and the start, as a loaded machine does it.
		const taken = await listen(port + 1);
		const begun = Date.now();
		let directory = "";
		try {
			const failed = await Effect.runPromise(
				Effect.flip(
					Effect.scoped(
						Local.start(
							{
								...environment,
								set: (name, value) => {
									directory = value;
									return environment.set(name, value);
								},
							},
							{ actors: [], logging: { level: "error" } },
							port,
						),
					),
				),
			);
			expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "port", retryable: true });
			expect(failed.message).toContain(String(port + 1));
		} finally {
			await close(taken);
		}
		// rivetkit alone fails this start after 60 seconds.
		expect(Date.now() - begun).toBeLessThan(20_000);
		expect(await Effect.runPromise(EngineProcess.running(directory))).toEqual([]);
		expect(existsSync(directory)).toBe(false);
		expect(process.env.RIVETKIT_STORAGE_PATH).toBeUndefined();
	}, 60_000);

	it("starts on another set when the first one has a taken port", async () => {
		const first = await Effect.runPromise(Ports.free);
		const taken = await listen(first + 10);
		try {
			const served = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const tried = yield* Ref.make<Array<number>>([]);
						const ports = Effect.gen(function* () {
							const port = (yield* Ref.get(tried)).length === 0 ? first : yield* Ports.free;
							yield* Ref.update(tried, (before) => [...before, port]);
							return port;
						});
						const engine = yield* Local.serveOn(ports, environment, {
							actors: [],
							logging: { level: "error" },
						});
						const health = yield* Effect.promise(() => fetch(`${engine.endpoint}/health`));
						return { endpoint: engine.endpoint, status: health.status, tried: yield* Ref.get(tried) };
					}),
				),
			);
			expect(served.tried).toHaveLength(2);
			expect(served.tried[0]).toBe(first);
			expect(served.endpoint).toBe(`http://127.0.0.1:${served.tried[1]}`);
			expect(served.status).toBe(200);
		} finally {
			await close(taken);
		}
		expect(process.env.RIVETKIT_STORAGE_PATH).toBeUndefined();
	}, 90_000);
});
