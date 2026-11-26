import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { InlineSandbox, Wasm } from "../src/index.ts";
import { lookup, records } from "./tools.ts";

describe("make", () => {
	it("runs a script on the calling thread with tools that are Effects", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load(), tools: [lookup] });
				return yield* sandbox.execute(`return (await tools.lookup({ id: "5" })).title;`);
			}).pipe(Effect.provide(records)),
		);
		expect(result).toMatchObject({ ok: true, value: "Record 5" });
	});

	it("ends a script that computes past its interrupt budget with a timeout", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load(), interruptBudget: 100 });
				return yield* sandbox.execute("while (true) {}");
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "timeout", message: "Execution exceeded its interrupt budget of 100" },
		});
	});
});
