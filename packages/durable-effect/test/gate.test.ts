import type { EntryRecord } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Gate, Hook, Signal, Tool } from "../src/index.ts";
import { answer, TestHarness, toolCall } from "../src/testing/index.ts";
import { untilTask } from "./until-task.ts";

const Approval = Signal.make("test.approval", 1, Schema.Struct({ allow: Schema.Boolean }));

/** A `write` tool that records the texts it was run with, and the harness of one call to it behind `gates`. */
function guarded(gates: ReadonlyArray<Hook.Hook<never>>) {
	const written: string[] = [];
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) =>
			Effect.sync(() => {
				written.push(text);
				return `wrote ${text}`;
			}),
	});
	const layer = TestHarness.layer({
		extensions: [{ name: "app", tools: [Write], hooks: gates }],
		responses: [toolCall("write", { text: "hi" }, { id: "call-1" }), answer("Done.")],
	});
	return { written, layer };
}

/** Asks the root conversation for the write and returns how the input settled and the call's result entry. */
const ask = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const settled = yield* root.prompt("Write hi.");
	yield* root.waitForIdle;
	const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
	return { settled, result: shown(entries.filter((entry) => entry.kind === "pi.tool-result")) };
});

/** The one tool result of a run, as the model and Pi's diagnostics show it. */
function shown(results: ReadonlyArray<EntryRecord>) {
	expect(results).toHaveLength(1);
	const message = results[0]?.model?.[0];
	const data = results[0]?.data as { readonly diagnostics: unknown } | undefined;
	return {
		isError: message?.role === "toolResult" && message.isError,
		content: message?.content,
		diagnostics: data?.diagnostics,
	};
}

describe("constructors", () => {
	it("make the tagged decisions, which toPi turns into what Pi's beforeTool returns", async () => {
		const gates = [
			Gate.allow,
			Gate.block("read only"),
			Gate.rewrite({ text: "HI" }),
			Gate.park({ signals: [Approval.key("a"), Approval.key("b")], until: 5_000 }),
			Gate.park({ until: 5_000 }),
			Gate.park({ signals: [Approval.key("a")] }),
		];
		expect(gates.map((gate) => gate._tag)).toEqual(["Allow", "Block", "Rewrite", "Park", "Park", "Park"]);
		expect(await Effect.runPromise(Effect.forEach(gates, Gate.toPi))).toEqual([
			undefined,
			{ block: "read only" },
			{ arguments: { text: "HI" } },
			{
				sleep: {
					signals: [
						{ signal: "test.approval", key: "a" },
						{ signal: "test.approval", key: "b" },
					],
					until: 5_000,
				},
			},
			{ sleep: { until: 5_000 } },
			{ sleep: { signals: [{ signal: "test.approval", key: "a" }] } },
		]);
	});

	it("fail toPi with SchemaConversionError when a parked signal's definition is one Pi rejects", async () => {
		const Bad = Signal.make("bad/name", 1, Schema.String);
		const error = await Effect.runPromise(Effect.flip(Gate.toPi(Gate.park({ signals: [Bad.key("a")] }))));
		expect(error).toMatchObject({
			_tag: "SchemaConversionError",
			reason: 'Signal name "bad/name" must be non-empty, without "/"',
		});
	});
});

describe("a beforeTool hook's gate", () => {
	it("allow runs the tool with the model's arguments", async () => {
		const { written, layer } = guarded([Hook.beforeTool(() => Effect.succeed(Gate.allow))]);
		const { settled, result } = await Effect.runPromise(Effect.provide(ask, layer));
		expect(settled.status).toBe("done");
		expect(written).toEqual(["hi"]);
		expect(result).toEqual({ isError: false, content: [{ type: "text", text: "wrote hi" }], diagnostics: [] });
	});

	it("block gives the model an error result with the reason, and the tool never runs", async () => {
		const { written, layer } = guarded([
			Hook.beforeTool((call) =>
				Effect.succeed(call.name.startsWith("write") ? Gate.block("read only") : Gate.allow),
			),
			// The first block stops the chain: this hook is never asked.
			Hook.beforeTool(() => Effect.succeed(Gate.rewrite({ text: "never" }))),
		]);
		const { settled, result } = await Effect.runPromise(Effect.provide(ask, layer));
		expect(settled.status).toBe("done");
		expect(written).toEqual([]);
		expect(result).toEqual({
			isError: true,
			content: [{ type: "text", text: "<harness>\n[error] Tool call blocked: read only\n</harness>" }],
			diagnostics: [{ severity: "error", code: "blocked", message: "Tool call blocked: read only" }],
		});
	});

	it("rewrite runs the tool with the new arguments, which a later hook sees", async () => {
		const seen: unknown[] = [];
		const { written, layer } = guarded([
			Hook.beforeTool(() => Effect.succeed(Gate.rewrite({ text: "HI" }))),
			Hook.beforeTool((call) =>
				Effect.sync(() => {
					seen.push(call.arguments);
					return Gate.allow;
				}),
			),
		]);
		const { result } = await Effect.runPromise(Effect.provide(ask, layer));
		expect(seen).toEqual([{ text: "HI" }]);
		expect(written).toEqual(["HI"]);
		expect(result).toEqual({ isError: false, content: [{ type: "text", text: "wrote HI" }], diagnostics: [] });
	});

	it("rewrite to arguments the tool's schema rejects ends the call with invalid_arguments, without running it", async () => {
		const { written, layer } = guarded([Hook.beforeTool(() => Effect.succeed(Gate.rewrite({ wrong: true })))]);
		const { result } = await Effect.runPromise(Effect.provide(ask, layer));
		expect(written).toEqual([]);
		expect(result).toMatchObject({ isError: true, diagnostics: [{ severity: "error", code: "invalid_arguments" }] });
	});

	it("park without a signal or a deadline ends the call with Pi's invalid_park", async () => {
		const { written, layer } = guarded([Hook.beforeTool(() => Effect.succeed(Gate.park({})))]);
		const { settled, result } = await Effect.runPromise(Effect.provide(ask, layer));
		expect(settled.status).toBe("done");
		expect(written).toEqual([]);
		expect(result).toMatchObject({ isError: true, diagnostics: [{ severity: "error", code: "invalid_park" }] });
	});

	it("park until a deadline wakes on the TestClock, and the gate reads that its signal expired", async () => {
		const passes: string[] = [];
		const { written, layer } = guarded([
			Hook.beforeTool((call, api) =>
				Effect.gen(function* () {
					// One deadline per question, fixed at the first pass: the hook is asked again on every wake.
					const until = yield* api.memo("test.until", (yield* api.now) + 60_000);
					const state = yield* api.readSignal(Approval, call.id);
					passes.push(
						`${yield* api.now} ${Option.match(state, { onNone: () => "nothing", onSome: (some) => some.kind })}`,
					);
					if (Option.isNone(state)) return Gate.park({ signals: [Approval.key(call.id)], until });
					return state.value.kind === "expired" ? Gate.block("No approval within a minute") : Gate.allow;
				}),
			),
		]);
		const started = performance.now();
		const seen = await runTest(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_000_000);
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Write hi." });
				yield* untilTask("sleeping");
				// One millisecond before the deadline nothing has moved, once Pi had a turn to move it.
				yield* TestClock.adjust(59_999);
				yield* Effect.yieldNow;
				const early = { passes: passes.length, status: (yield* submission.status).status };
				yield* TestClock.adjust(1);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return { early, settled, result: shown(entries.filter((entry) => entry.kind === "pi.tool-result")) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.early).toEqual({ passes: 1, status: "placed" });
		expect(passes).toEqual(["1000000 nothing", "1060000 expired"]);
		expect(seen.settled.status).toBe("done");
		expect(written).toEqual([]);
		expect(seen.result).toEqual({
			isError: true,
			content: [
				{ type: "text", text: "<harness>\n[error] Tool call blocked: No approval within a minute\n</harness>" },
			],
			diagnostics: [
				{ severity: "error", code: "blocked", message: "Tool call blocked: No approval within a minute" },
			],
		});
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("park on a deadline alone wakes on the TestClock and lets the call run", async () => {
		const passes: number[] = [];
		const { written, layer } = guarded([
			Hook.beforeTool((_call, api) =>
				Effect.gen(function* () {
					const until = yield* api.memo("test.until", (yield* api.now) + 5_000);
					const now = yield* api.now;
					passes.push(now);
					return now < until ? Gate.park({ until }) : Gate.allow;
				}),
			),
		]);
		const settled = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Write hi." });
				yield* untilTask("sleeping");
				yield* TestClock.adjust(5_000);
				return yield* submission.wait;
			}).pipe(Effect.provide(layer)),
		);
		expect(settled.status).toBe("done");
		expect(passes).toEqual([0, 5_000]);
		expect(written).toEqual(["hi"]);
	});
});
