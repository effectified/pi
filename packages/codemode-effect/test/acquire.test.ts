import { Tool } from "@effectified/pi-agent";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Schema, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { InlineSandbox, type Sandbox, Wasm } from "../src/index.ts";
import { broken, greet, held, lookup, records, refuse } from "./tools.ts";

/** An inline sandbox, the cheapest kind; what these tests check is the same for every kind. */
function sandboxWith(options: Omit<InlineSandbox.Options<never>, "wasm"> = {}) {
	return Effect.flatMap(Wasm.load(), (wasm) => InlineSandbox.make({ ...options, wasm }));
}

describe("execute", () => {
	it("runs a script that calls the tools, with their output, value and calls", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* InlineSandbox.make({ wasm: yield* Wasm.load(), tools: [lookup, greet] });
				return yield* sandbox.execute(`
					const record = await tools.lookup({ id: "7" });
					text(await tools.greet({ name: record.title }));
					return record;
				`);
			}).pipe(Effect.provide(records)),
		);
		expect(result).toMatchObject({
			ok: true,
			value: { title: "Record 7" },
			output: [{ type: "text", text: "Hello, Record 7" }],
			calls: [
				{ name: "lookup", status: "ok" },
				{ name: "greet", status: "ok" },
			],
		});
	});

	it("succeeds with a failed result when the script fails, and a tool's failure reaches the script", async () => {
		const [thrown, caught] = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* sandboxWith({ tools: [refuse, broken] });
				return [
					yield* sandbox.execute(`text("before"); throw new TypeError("boom");`),
					yield* sandbox.execute(`
						const messages = [];
						for (const call of [tools.refuse({}), tools.broken({})]) {
							try { await call; } catch (error) { messages.push(error.message); }
						}
						return messages;
					`),
				] as const;
			}),
		);
		expect(thrown).toMatchObject({ ok: false, error: { kind: "script", name: "TypeError", message: "boom" } });
		expect(thrown.output).toEqual([{ type: "text", text: "before" }]);
		expect(caught).toMatchObject({ ok: true, value: ["not allowed", "the disk is gone"] });
	});

	it("passes the store and reports the script's writes", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* sandboxWith();
				return yield* sandbox.execute(`store("runs", load("runs") + 1); store("old", undefined);`, {
					store: { runs: 1, old: true },
				});
			}),
		);
		expect(result).toMatchObject({ ok: true, storeWrites: { set: { runs: 2 }, delete: ["old"] } });
	});

	it("aborts the execution when its fiber is interrupted: the tool's handler is interrupted", async () => {
		const exit = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const interrupted = yield* Latch.make();
				const sandbox = yield* sandboxWith({ tools: [held(started, interrupted)] });
				const fiber = yield* Effect.forkChild(sandbox.execute("await tools.wait({});"), { startImmediately: true });
				yield* started.await;
				yield* Fiber.interrupt(fiber);
				yield* interrupted.await;
				return yield* Fiber.await(fiber);
			}),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});
});

describe("the scope", () => {
	it("aborts an execution that still runs when it closes", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const interrupted = yield* Latch.make();
				const scope = yield* Scope.make();
				const sandbox = yield* Scope.provide(sandboxWith({ tools: [held(started, interrupted)] }), scope);
				const fiber = yield* Effect.forkChild(sandbox.execute("await tools.wait({});"), { startImmediately: true });
				yield* started.await;
				yield* Scope.close(scope, Exit.void);
				yield* interrupted.await;
				return yield* Fiber.join(fiber);
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "aborted" },
			calls: [{ name: "wait", status: "cancelled" }],
		});
	});

	it("leaves a sandbox that refuses executions and runs with SandboxClosed", async () => {
		const failures = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* Effect.scoped(sandboxWith());
				return [
					yield* Effect.flip(sandbox.execute("return 1;")),
					yield* Effect.flip(Effect.scoped(sandbox.start("return 1;", { seed: 1 }))),
				];
			}),
		);
		expect(failures.map((failure) => [failure._tag, failure.message])).toEqual([
			["SandboxClosed", "Sandbox is closed"],
			["SandboxClosed", "Sandbox is closed"],
		]);
	});
});

describe("tools and globals", () => {
	it("registers and unregisters tools for later executions, and refuses a name registered twice", async () => {
		const [names, duplicate, removed, again, value] = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* sandboxWith({ tools: [greet] });
				yield* sandbox.register(lookup);
				const names = (yield* sandbox.tools).map((tool) => tool.name);
				const duplicate = yield* Effect.flip(sandbox.register(greet));
				const removed = yield* sandbox.unregister(greet.name);
				const again = yield* sandbox.unregister(greet.name);
				const result = yield* sandbox.execute(`return Object.keys(tools);`);
				return [names, duplicate, removed, again, result.ok ? result.value : undefined] as const;
			}).pipe(Effect.provide(records)),
		);
		expect(names).toEqual(["greet", "lookup"]);
		expect(duplicate).toMatchObject({ _tag: "ToolRejected", message: 'Tool "greet" is already registered' });
		expect([removed, again]).toEqual([true, false]);
		expect(value).toEqual(["lookup"]);
	});

	it("fails with ToolRejected for tools of one name and for an invalid global", async () => {
		const shadow = Tool.make("text", {
			label: "Text",
			description: "Shadows a built-in.",
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.succeed(""),
		});
		const failures = await runTest(
			Effect.all([
				Effect.flip(sandboxWith({ tools: [greet, greet] })),
				Effect.flip(sandboxWith({ globals: [{ tool: shadow }] })),
			]),
		);
		expect(failures.map((failure) => [failure._tag, failure.message])).toEqual([
			["ToolRejected", 'Tool "greet" is already registered'],
			["ToolRejected", 'Invalid global name "text"'],
		]);
	});

	it("keeps the globals it was made with", async () => {
		const names = await runTest(
			Effect.map(sandboxWith({ globals: [{ tool: greet }] }), (sandbox: Sandbox.Sandbox) =>
				sandbox.globals.map((global) => global.name),
			),
		);
		expect(names).toEqual(["greet"]);
	});
});
