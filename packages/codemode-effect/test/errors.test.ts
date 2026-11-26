import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	type CodemodeFailure,
	CodemodeSourceError,
	DeliveryRejected,
	RunRejected,
	SandboxClosed,
	ToolRejected,
	WasmLoadFailed,
} from "../src/index.ts";

describe("the errors", () => {
	it("are tagged, carry Pi's message, and a catchTags covers the union", async () => {
		const failures: ReadonlyArray<CodemodeFailure> = [
			new CodemodeSourceError({ message: "empty" }),
			new SandboxClosed({ message: "Sandbox is closed" }),
			new ToolRejected({ message: "duplicate" }),
			new RunRejected({ message: "seed" }),
			new DeliveryRejected({ message: "not waiting" }),
			new WasmLoadFailed({ message: "missing", cause: new Error("ENOENT") }),
		];
		const handled = await Effect.runPromise(
			Effect.forEach(failures, (failure) =>
				Effect.fail(failure).pipe(
					Effect.catchTags({
						CodemodeSourceError: (error) => Effect.succeed(`source: ${error.message}`),
						SandboxClosed: (error) => Effect.succeed(`closed: ${error.message}`),
						ToolRejected: (error) => Effect.succeed(`tool: ${error.message}`),
						RunRejected: (error) => Effect.succeed(`run: ${error.message}`),
						DeliveryRejected: (error) => Effect.succeed(`delivery: ${error.message}`),
						WasmLoadFailed: (error) => Effect.succeed(`wasm: ${error.message}`),
					}),
				),
			),
		);
		expect(handled).toEqual([
			"source: empty",
			"closed: Sandbox is closed",
			"tool: duplicate",
			"run: seed",
			"delivery: not waiting",
			"wasm: missing",
		]);
	});
});
