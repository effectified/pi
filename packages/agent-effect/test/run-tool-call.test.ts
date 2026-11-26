import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Latch, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runToolCall, Tool } from "../src/index.ts";

const Add = Tool.make("add", {
	label: "Add",
	description: "Add two numbers.",
	parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
	success: Schema.Number,
	handler: ({ a, b }, api) =>
		Effect.as(api.update({ content: [{ type: "text", text: "adding" }], details: undefined }), a + b),
});

const call = fauxToolCall("add", { a: 2, b: 3 }, { id: "call-1" });
const base = { assistantMessage: fauxAssistantMessage([call]), context: { messages: [] }, tools: [Add] };

describe("runToolCall", () => {
	it("runs the call through Pi's steps and reports its progress through an Effect", async () => {
		const updates: AgentToolResult[] = [];
		const outcome = await runTest(
			runToolCall(call, { ...base, onUpdate: (partial) => Effect.sync(() => void updates.push(partial)) }),
		);
		expect(outcome).toMatchObject({ toolCall: call, isError: false, result: { content: [{ text: "5" }] } });
		expect(updates).toHaveLength(1);
	});

	it("asks beforeToolCall and afterToolCall as Effects", async () => {
		const blocked = await runTest(
			runToolCall(call, { ...base, beforeToolCall: () => Effect.succeed({ block: true, reason: "denied" }) }),
		);
		expect(blocked).toMatchObject({ isError: true, result: { content: [{ text: "denied" }] } });
		const replaced = await runTest(
			runToolCall(call, { ...base, afterToolCall: () => Effect.succeed({ details: { audited: true } }) }),
		);
		expect(replaced.result.details).toEqual({ audited: true });
	});

	it("gives an unknown tool as an outcome with isError, as Pi does", async () => {
		const outcome = await runTest(runToolCall(fauxToolCall("missing", {}), base));
		expect(outcome).toMatchObject({ isError: true, result: { content: [{ text: "Tool missing not found" }] } });
	});

	it("aborts the call when interrupted", async () => {
		const stopped = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const interrupted = yield* Latch.make();
				const Waits = Tool.make("add", {
					label: "Waits",
					description: "Waits.",
					parameters: Schema.Struct({}),
					success: Schema.String,
					handler: () =>
						Effect.andThen(Latch.open(started), Effect.never).pipe(
							Effect.onInterrupt(() => Latch.open(interrupted)),
						),
				});
				const fiber = yield* Effect.forkChild(runToolCall(call, { ...base, tools: [Waits] }), {
					startImmediately: true,
				});
				yield* started.await;
				yield* Fiber.interrupt(fiber);
				yield* interrupted.await;
				return true;
			}),
		);
		expect(stopped).toBe(true);
	});
});
