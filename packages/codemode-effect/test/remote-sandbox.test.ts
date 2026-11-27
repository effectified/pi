import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { type CodemodeRemote, type CodemodeWasmModule, RemoteSandbox, Wasm } from "../src/index.ts";
import { lookup, records } from "./tools.ts";

/** A remote in this process, as a Durable Object stub would be across Workers RPC: `serve` behind `execute`. */
function inProcess(wasm: CodemodeWasmModule): CodemodeRemote {
	return { execute: (request, exchange) => Effect.runPromise(RemoteSandbox.serve(request, exchange, { wasm })) };
}

describe("make and serve", () => {
	it("run the VM on the remote and the tools here, asking for a remote once per execution", async () => {
		const [first, second, remotes] = await runTest(
			Effect.gen(function* () {
				const remote = inProcess(yield* Wasm.load());
				const asked = yield* Ref.make(0);
				const sandbox = yield* RemoteSandbox.make({
					tools: [lookup],
					remote: Effect.as(
						Ref.update(asked, (n) => n + 1),
						remote,
					),
				});
				const execute = sandbox.execute(`text("from the remote"); return (await tools.lookup({ id: "9" })).title;`);
				return [yield* execute, yield* execute, yield* Ref.get(asked)] as const;
			}).pipe(Effect.provide(records)),
		);
		expect(first).toMatchObject({
			ok: true,
			value: "Record 9",
			output: [{ type: "text", text: "from the remote" }],
			calls: [{ name: "lookup", status: "ok" }],
		});
		expect(second).toMatchObject({ ok: true, value: "Record 9" });
		expect(remotes).toBe(2);
	});

	it("serve caps the request's interrupt budget at its own", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const wasm = yield* Wasm.load();
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				const remote: CodemodeRemote = {
					execute: (request, exchange) =>
						runPromise(RemoteSandbox.serve(request, exchange, { wasm, maxInterruptBudget: 100 })),
				};
				const sandbox = yield* RemoteSandbox.make({ remote: Effect.succeed(remote), interruptBudget: 1_000_000 });
				return yield* sandbox.execute("while (true) {}");
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(result.ok ? "" : result.error.message).toContain("100");
	});
});
