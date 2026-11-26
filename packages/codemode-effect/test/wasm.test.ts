import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Wasm } from "../src/index.ts";

describe("load", () => {
	it("compiles the installed QuickJS module once: a second load is the same module", async () => {
		const [first, second] = await runTest(Effect.all([Wasm.load(), Wasm.load()]));
		expect(first).toBe(second);
		expect(Object.prototype.toString.call(first)).toBe("[object WebAssembly.Module]");
	});

	it("fails with WasmLoadFailed for a file that is not there", async () => {
		const failure = await runTest(Effect.flip(Wasm.load("/nonexistent/quickjs.wasm")));
		expect(failure._tag).toBe("WasmLoadFailed");
		expect(failure.message).toContain("/nonexistent/quickjs.wasm");
	});
});
