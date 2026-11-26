import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@effectified/pi-ai";
import { fauxAssistantMessage, fauxToolCall, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Latch, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { AgentLoop, Tool } from "../src/index.ts";
import { held, model, scripted } from "./scripted.ts";

const Add = Tool.make("add", {
	label: "Add",
	description: "Add two numbers.",
	parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
	success: Schema.Number,
	handler: ({ a, b }) => Effect.succeed(a + b),
});

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/** Pi's own conversion: the messages a model understands, unchanged. */
// The messages a model reads; other roles (pi-coding-agent adds some to AgentMessage) stay out.
const isLlmMessage = (message: AgentMessage): message is Message =>
	message.role === "system" ||
	message.role === "user" ||
	message.role === "assistant" ||
	message.role === "toolResult";

const convertToLlm = (messages: AgentMessage[]) => Effect.succeed(messages.filter(isLlmMessage));

describe("AgentLoop.stream", () => {
	it("emits Pi's events of a run with a tool call, agent_start first and agent_end last", async () => {
		const events = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) =>
					models.setResponses([
						fauxAssistantMessage([fauxToolCall("add", { a: 2, b: 3 }, { id: "call-1" })], {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage("5"),
					]),
				);
				const config = { model: yield* model, convertToLlm };
				return yield* Stream.runCollect(AgentLoop.stream([user("2 + 3?")], { messages: [], tools: [Add] }, config));
			}).pipe(Effect.provide(scripted)),
		);
		const types = events.map((event) => event.type).filter((type) => type !== "message_update");
		expect(types[0]).toBe("agent_start");
		expect(types.at(-1)).toBe("agent_end");
		expect(types).toContain("tool_execution_end");
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(end).toMatchObject({ toolName: "add", isError: false, result: { content: [{ text: "5" }] } });
	});

	it("aborts the run when the Stream ends early, and waits until Pi has settled it", async () => {
		const asked = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				yield* ScriptedModels.use((models) => models.setResponses([held(started), fauxAssistantMessage("never")]));
				const config = { model: yield* model, convertToLlm };
				const first = yield* Stream.runHead(AgentLoop.stream([user("hi")], { messages: [] }, config));
				return { first, calls: yield* ScriptedModels.use((models) => models.callCount) };
			}).pipe(Effect.provide(scripted)),
		);
		expect(asked.first._tag).toBe("Some");
		// Only the held request was made: the run did not go on to another one.
		expect(asked.calls).toBeLessThanOrEqual(1);
	});

	it("aborts the model request when the consumer is interrupted", async () => {
		const aborted = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				yield* ScriptedModels.use((models) => models.setResponses([held(started)]));
				const config = { model: yield* model, convertToLlm };
				const fiber = yield* Effect.forkChild(
					Stream.runCollect(AgentLoop.stream([user("hi")], { messages: [] }, config)),
					{ startImmediately: true },
				);
				yield* started.await;
				yield* Fiber.interrupt(fiber);
				return yield* ScriptedModels.use((models) => models.pendingResponseCount);
			}).pipe(Effect.provide(scripted)),
		);
		expect(aborted).toBe(0);
	});

	it("asks the hooks as Effects: a blocked tool call becomes Pi's error result", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) =>
					models.setResponses([
						fauxAssistantMessage([fauxToolCall("add", { a: 1, b: 1 })], { stopReason: "toolUse" }),
						fauxAssistantMessage("blocked"),
					]),
				);
				const config: AgentLoop.Config<never> = {
					model: yield* model,
					convertToLlm,
					beforeToolCall: ({ toolCall }) => Effect.succeed({ block: true, reason: `no ${toolCall.name}` }),
				};
				const messages = yield* AgentLoop.run([user("1 + 1?")], { messages: [], tools: [Add] }, config);
				return messages.filter((message) => message.role === "toolResult");
			}).pipe(Effect.provide(scripted)),
		);
		expect(results).toMatchObject([{ isError: true, content: [{ type: "text", text: "no add" }] }]);
	});

	it("adds the steering messages an Effect gives before the next request", async () => {
		const requests = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) =>
					models.setResponses([
						fauxAssistantMessage([fauxToolCall("add", { a: 1, b: 2 })], { stopReason: "toolUse" }),
						fauxAssistantMessage("3, and noted"),
					]),
				);
				let steered = false;
				const config: AgentLoop.Config<never> = {
					model: yield* model,
					convertToLlm,
					getSteeringMessages: Effect.sync(() => {
						if (steered) return [];
						steered = true;
						return [user("also say noted")];
					}),
				};
				const messages = yield* AgentLoop.run([user("1 + 2?")], { messages: [], tools: [Add] }, config);
				return messages.map((message) => message.role);
			}).pipe(Effect.provide(scripted)),
		);
		// The steering message Pi asked for at the start arrives before the first request.
		expect(requests.filter((role) => role === "user")).toHaveLength(2);
		expect(requests.at(-1)).toBe("assistant");
	});
});

describe("AgentLoop.run", () => {
	it("is the messages of agent_end: the prompts first, then the run's", async () => {
		const messages = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([fauxAssistantMessage("hello")]));
				return yield* AgentLoop.run([user("hi")], { messages: [] }, { model: yield* model, convertToLlm });
			}).pipe(Effect.provide(scripted)),
		);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});

describe("AgentLoop.streamContinue and runContinue", () => {
	it("continue from a context that ends in a user message", async () => {
		const messages = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([fauxAssistantMessage("again")]));
				return yield* AgentLoop.runContinue({ messages: [user("retry")] }, { model: yield* model, convertToLlm });
			}).pipe(Effect.provide(scripted)),
		);
		expect(messages.map((message) => message.role)).toEqual(["assistant"]);
	});

	it("fail with CannotContinue for an empty context or one that ends in an assistant message", async () => {
		const failures = await runTest(
			Effect.gen(function* () {
				const config = { model: yield* model, convertToLlm };
				const empty = yield* Effect.flip(AgentLoop.runContinue({ messages: [] }, config));
				const answered = yield* Effect.flip(
					Stream.runDrain(
						AgentLoop.streamContinue({ messages: [user("hi"), fauxAssistantMessage("done")] }, config),
					),
				);
				return [empty, answered];
			}).pipe(Effect.provide(scripted)),
		);
		expect(failures.map((failure) => failure._tag)).toEqual(["CannotContinue", "CannotContinue"]);
		expect(failures[1]?.message).toBe("Cannot continue from message role: assistant");
	});
});
