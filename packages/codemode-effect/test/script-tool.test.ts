import { Tool } from "@effectified/pi-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Latch, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InlineSandbox, ScriptTool, Wasm } from "../src/index.ts";
import { broken, greet, held, lookup, records, refuse } from "./tools.ts";

describe("fromAgent", () => {
	it("declares the JSON Schemas of the tool: the success value's when structured, a string otherwise", async () => {
		const [structured, text, lookupTool, greetTool] = await runTest(
			Effect.all([
				ScriptTool.fromAgent(lookup),
				ScriptTool.fromAgent(greet),
				lookup.agentTool,
				greet.agentTool,
			]).pipe(Effect.provide(records)),
		);
		expect(structured).toMatchObject({
			name: "lookup",
			description: "Look a record up by id.",
			inputSchema: lookupTool.parameters,
			outputSchema: lookupTool.outputSchema,
		});
		expect(text).toMatchObject({ name: "greet", inputSchema: greetTool.parameters });
		expect(text.outputSchema).toEqual({ type: "string" });
	});

	it("answers with the structured value, or with the text, from a handler run with the context's services", async () => {
		const [structured, text] = await runTest(
			Effect.all([ScriptTool.fromAgent(lookup), ScriptTool.fromAgent(greet)]).pipe(Effect.provide(records)),
		);
		const { signal } = new AbortController();
		expect(await structured.execute({ id: "7" }, { signal })).toEqual({ title: "Record 7" });
		expect(await text.execute({ name: "Ada" }, { signal })).toBe("Hello, Ada");
	});

	it("rejects with the text of an error result, and with the message of a failure", async () => {
		const [refusing, failing] = await runTest(
			Effect.all([ScriptTool.fromAgent(refuse), ScriptTool.fromAgent(broken)]),
		);
		const { signal } = new AbortController();
		await expect(Promise.resolve(refusing.execute({}, { signal }))).rejects.toThrow("not allowed");
		await expect(Promise.resolve(failing.execute({}, { signal }))).rejects.toThrow("the disk is gone");
	});

	it("interrupts the handler when Pi aborts the call", async () => {
		const interrupted = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const interrupted = yield* Latch.make();
				const tool = yield* ScriptTool.fromAgent(held(started, interrupted));
				const controller = new AbortController();
				const call = Promise.resolve(tool.execute({}, { signal: controller.signal }));
				yield* started.await;
				controller.abort();
				yield* Effect.promise(() => call.catch(() => undefined));
				yield* interrupted.await;
				return true;
			}),
		);
		expect(interrupted).toBe(true);
	});
});

describe("global", () => {
	const add = Tool.make("add", {
		label: "Add",
		description: "Add two numbers.",
		parameters: Schema.Tuple([Schema.Number, Schema.Number]),
		success: Schema.Number,
		structured: true,
		handler: ([a, b]) => Effect.succeed(a + b),
	});

	it("carries spread and signature, and a spread global gets the call's arguments", async () => {
		const [declared, value] = await runTest(
			Effect.gen(function* () {
				const declared = yield* ScriptTool.global({
					tool: add,
					spread: true,
					signature: "(a: number, b: number): Promise<number>",
				});
				const sandbox = yield* InlineSandbox.make({
					wasm: yield* Wasm.load(),
					globals: [{ tool: add, spread: true }],
				});
				const result = yield* sandbox.execute("return await add(2, 3);");
				return [declared, result.ok ? result.value : result.error.message] as const;
			}),
		);
		expect(declared).toMatchObject({
			name: "add",
			spread: true,
			signature: "(a: number, b: number): Promise<number>",
		});
		expect(value).toBe(5);
	});
});
