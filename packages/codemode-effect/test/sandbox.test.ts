import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { InlineSandbox, Sandbox, Wasm } from "../src/index.ts";
import { greet } from "./tools.ts";

const inline = Sandbox.layer(Effect.flatMap(Wasm.load(), (wasm) => InlineSandbox.make({ wasm, tools: [greet] })));

describe("layer", () => {
	it("gives the sandbox as Current, closed when the Layer is released", async () => {
		const [result, closed] = await runTest(
			Effect.gen(function* () {
				const [sandbox, result] = yield* Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(inline);
						return yield* Sandbox.Current.use((sandbox) =>
							Effect.map(
								sandbox.execute(`return await tools.greet({ name: "Ada" });`),
								(result) => [sandbox, result] as const,
							),
						).pipe(Effect.provide(context));
					}),
				);
				return [result, yield* Effect.flip(sandbox.execute("return 1;"))] as const;
			}),
		);
		expect(result).toMatchObject({ ok: true, value: "Hello, Ada" });
		expect(closed._tag).toBe("SandboxClosed");
	});
});
