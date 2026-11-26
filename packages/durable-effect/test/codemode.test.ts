import { CodemodeStoreDoc, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { InlineSandbox, Wasm } from "@effectified/pi-codemode";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { CODEMODE_TOOL_NAME, extension, store, tool } from "../src/codemode.ts";
import { Extension, Harness, Tool } from "../src/index.ts";
import { answer, TestHarness, toolCall } from "../src/testing/index.ts";

const Double = Tool.make("double", {
	description: "Double a number.",
	parameters: Schema.Struct({ n: Schema.Number }),
	success: Schema.Number,
	callers: ["tools"],
	handler: ({ n }) => Effect.succeed(n * 2),
});

describe("code mode", () => {
	it("runs the model's script on a sandbox of @effectified/pi-codemode, calling the conversation's tools", async () => {
		const seen = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load() });
					const made = extension({ sandbox, models: false });
					return yield* Effect.gen(function* () {
						const root = yield* TestHarness.root;
						yield* root.prompt("Double 21 and keep it.");
						const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
						const result = entries.find((entry) => entry.kind === "pi.tool-result");
						const kept = yield* Harness.snapshot(store, root.id);
						return { result: result?.model?.[0]?.content, kept, made };
					}).pipe(
						Effect.provide(
							TestHarness.layer({
								extensions: [Extension.make({ name: "app", tools: [Double] }), made],
								responses: [
									toolCall(CODEMODE_TOOL_NAME, {
										code: 'const n = await tools.double({ n: 21 }); store("answer", n); return n;',
									}),
									answer("42."),
								],
							}),
						),
					);
				}),
			),
		);
		expect(JSON.stringify(seen.result)).toContain("42");
		// Code mode keeps what a script stores as its JSON text.
		expect(Option.map(seen.kept, (value) => value.values.answer)).toEqual(Option.some("42"));
		// The same extension as Pi's: its tools and its section.
		const pi = createCodemodeExtension({
			sandbox: { execute: () => Promise.reject(new Error("unused")) } as never,
			models: false,
		});
		expect([
			seen.made.name,
			seen.made.tools?.map((made) => made.name),
			seen.made.sections?.map((made) => made.key),
		]).toEqual([pi.name, pi.tools?.map((made) => made.name), pi.sections?.map((made) => made.key)]);
	});

	it("tool alone is the code mode tool, and store reads Pi's document", () => {
		const made = tool({ sandbox: { pi: {} as never } });
		expect([made.name, store.kind, store.token]).toEqual([CODEMODE_TOOL_NAME, "pi.codemode.store", CodemodeStoreDoc]);
	});
});
