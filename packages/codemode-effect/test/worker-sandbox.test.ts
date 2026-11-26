import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Ref, Semaphore } from "effect";
import { describe, expect, it } from "vitest";
import { Wasm, WorkerSandbox } from "../src/index.ts";
import { lookup, records } from "./tools.ts";

describe("make", () => {
	it("runs a script in a worker thread, with tools whose handlers get the context's services", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* WorkerSandbox.make({ tools: [lookup], wasm: yield* Wasm.load() });
				return yield* sandbox.execute(`return (await tools.lookup({ id: "3" })).title;`);
			}).pipe(Effect.provide(records)),
		);
		expect(result).toMatchObject({ ok: true, value: "Record 3" });
	});

	it("ends a script that computes past Pi's deadline with a timeout", async () => {
		const result = await runTest(
			Effect.flatMap(WorkerSandbox.make({ timeoutMs: 20 }), (sandbox) => sandbox.execute("while (true) {}")),
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
	});
});

describe("the worker callbacks", () => {
	it("reserve a worker before it starts and release it when the worker exits, which onWorkerStarted awaits", async () => {
		const [during, exits, after] = await runTest(
			Effect.gen(function* () {
				const slots = yield* Semaphore.make(1);
				const exited = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
				const sandbox = yield* WorkerSandbox.make({
					acquireWorker: Effect.as(slots.take(1), slots.release(1)),
					onWorkerStarted: (exit) => Ref.update(exited, (all) => [...all, exit]),
				});
				const result = yield* sandbox.execute(`return 1;`);
				const during = result.ok;
				const exits = yield* Ref.get(exited);
				yield* Effect.all(exits);
				return [during, exits.length, yield* slots.takeIfAvailable(1)] as const;
			}),
		);
		expect([during, exits, after]).toEqual([true, 1, true]);
	});

	it("deny admission when acquireWorker fails: the execution ends with a sandbox error and no worker starts", async () => {
		const [result, started] = await runTest(
			Effect.gen(function* () {
				const workers = yield* Ref.make(0);
				const sandbox = yield* WorkerSandbox.make({
					acquireWorker: Effect.fail(new Error("no capacity")),
					onWorkerStarted: () => Ref.update(workers, (n) => n + 1),
				});
				return [yield* sandbox.execute(`return 1;`), yield* Ref.get(workers)] as const;
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "sandbox" } });
		expect(result.ok ? "" : result.error.message).toContain("no capacity");
		expect(started).toBe(0);
	});
});
