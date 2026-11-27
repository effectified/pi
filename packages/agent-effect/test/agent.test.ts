import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	runTest,
	ScriptedModels,
} from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Agent, Tool } from "../src/index.ts";
import { held, model, scripted } from "./scripted.ts";

const Add = Tool.make("add", {
	label: "Add",
	description: "Add two numbers.",
	parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
	success: Schema.Number,
	handler: ({ a, b }) => Effect.succeed(a + b),
});

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/** An agent on the scripted model, answering with `responses` in order. */
const agentWith = (responses: readonly FauxResponseStep[], options?: Agent.Options<never>) =>
	Effect.gen(function* () {
		yield* ScriptedModels.use((models) => models.setResponses(responses));
		return yield* Agent.make({ ...options, initialState: { model: yield* model, ...options?.initialState } });
	});

const roles = (messages: ReadonlyArray<AgentMessage>) => messages.map((message) => message.role);

describe("Agent.make and prompt", () => {
	it("runs a prompt with a tool to its end and keeps the transcript", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith(
					[
						fauxAssistantMessage([fauxToolCall("add", { a: 2, b: 3 })], { stopReason: "toolUse" }),
						fauxAssistantMessage("5"),
					],
					{ initialState: { systemPrompt: "You add.", tools: [Add] } },
				);
				yield* agent.prompt("2 + 3?");
				return yield* agent.state;
			}).pipe(Effect.provide(scripted)),
		);
		expect(roles(state.messages)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
		expect(state.systemPrompt).toBe("You add.");
		expect(state.isStreaming).toBe(false);
		expect(state.tools.map((tool) => tool.name)).toEqual(["add"]);
	});

	it("stamps a text prompt with Clock", async () => {
		const timestamp = await runTest(
			Effect.gen(function* () {
				yield* TestClock.setTime(1_700_000_000_000);
				const agent = yield* agentWith([fauxAssistantMessage("hi")]);
				yield* agent.prompt("hello");
				const { messages } = yield* agent.state;
				return messages.find((message) => message.role === "user")?.timestamp;
			}).pipe(Effect.provide(scripted)),
		);
		expect(timestamp).toBe(1_700_000_000_000);
	});

	it("fails with AgentBusy while a run is going, with Pi's message", async () => {
		const busy = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const agent = yield* agentWith([held(started)]);
				yield* Effect.forkChild(agent.prompt("first"), { startImmediately: true });
				yield* started.await;
				const failures = [yield* Effect.flip(agent.prompt("second")), yield* Effect.flip(agent.reset)];
				yield* agent.abort;
				yield* agent.waitForIdle;
				return failures;
			}).pipe(Effect.provide(scripted)),
		);
		expect(busy.map((failure) => failure._tag)).toEqual(["AgentBusy", "AgentBusy"]);
		expect(busy[0]?.message).toContain("already processing");
	});

	it("aborts the run when the prompt is interrupted, and is idle once the interruption is done", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const agent = yield* agentWith([held(started)]);
				const fiber = yield* Effect.forkChild(agent.prompt("wait"), { startImmediately: true });
				yield* started.await;
				yield* Fiber.interrupt(fiber);
				return yield* agent.state;
			}).pipe(Effect.provide(scripted)),
		);
		expect(state.isStreaming).toBe(false);
		expect(state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("aborts a run that is going when its scope closes", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const scope = yield* Scope.make();
				const agent = yield* Scope.provide(agentWith([held(started)]), scope);
				yield* Effect.forkChild(agent.prompt("wait"), { startImmediately: true });
				yield* started.await;
				yield* Scope.close(scope, Exit.void);
				return yield* agent.state;
			}).pipe(Effect.provide(scripted)),
		);
		expect(state.isStreaming).toBe(false);
		expect(state.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
	});
});

describe("continue", () => {
	it("fails with CannotContinue when there is nothing to continue from", async () => {
		const failure = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([]);
				return yield* Effect.flip(agent.continue);
			}).pipe(Effect.provide(scripted)),
		);
		expect(failure._tag).toBe("CannotContinue");
		expect(failure.message).toBe("No messages to continue from");
	});

	it("runs the queued follow-up messages from an assistant message", async () => {
		const messages = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
				yield* agent.prompt("hi");
				yield* agent.followUp(user("and then?"));
				expect(yield* agent.hasQueuedMessages).toBe(true);
				expect(yield* agent.peekQueuedMessages).toHaveLength(1);
				yield* agent.continue;
				return (yield* agent.state).messages;
			}).pipe(Effect.provide(scripted)),
		);
		expect(roles(messages)).toEqual(["user", "assistant", "user", "assistant"]);
	});
});

describe("stream and subscribe", () => {
	it("stream gives the events of one prompt's run, from agent_start to agent_end", async () => {
		const events = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("hello")]);
				return yield* Stream.runCollect(agent.stream("hi"));
			}).pipe(Effect.provide(scripted)),
		);
		expect(events[0]?.type).toBe("agent_start");
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("stream settles when a consumer that lags behind a full buffer is interrupted, and the agent is idle", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("word ".repeat(400))]);
				const reading = yield* Latch.make();
				// The consumer takes one event and never another, so the run fills the buffer and waits.
				const lagging = Stream.runForEach(agent.stream("talk"), () =>
					Effect.andThen(Latch.open(reading), Effect.never),
				);
				const fiber = yield* Effect.forkChild(lagging, { startImmediately: true });
				yield* reading.await;
				// Pi's loop runs on microtasks: by now it has filled the buffer and waits for the consumer.
				yield* Effect.repeat(Effect.yieldNow, { times: 50 });
				yield* Fiber.interrupt(fiber);
				return yield* agent.state;
			}).pipe(Effect.provide(scripted)),
		);
		expect(state.isStreaming).toBe(false);
	});

	it("closing its scope settles a run whose stream consumer stopped reading, and the agent is idle", async () => {
		const state = await runTest(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const agent = yield* Scope.provide(agentWith([fauxAssistantMessage("word ".repeat(400))]), scope);
				const reading = yield* Latch.make();
				// The consumer takes one event and never another, and nothing interrupts it: only the agent's scope closes.
				const lagging = Stream.runForEach(agent.stream("talk"), () =>
					Effect.andThen(Latch.open(reading), Effect.never),
				);
				yield* Effect.forkChild(lagging, { startImmediately: true });
				yield* reading.await;
				yield* Effect.repeat(Effect.yieldNow, { times: 50 });
				yield* Scope.close(scope, Exit.void);
				return yield* agent.state;
			}).pipe(Effect.provide(scripted)),
		);
		expect(state.isStreaming).toBe(false);
	});

	it("stream holds every event for a consumer that lags, though the run is aborted meanwhile", async () => {
		const events = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("word ".repeat(400))]);
				const reading = yield* Latch.make();
				const resume = yield* Latch.make();
				const collected = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.mapEffect(agent.stream("talk"), (event) =>
							Effect.as(Effect.andThen(Latch.open(reading), resume.await), event),
						),
					),
					{ startImmediately: true },
				);
				yield* reading.await;
				yield* Effect.repeat(Effect.yieldNow, { times: 50 });
				yield* agent.abort;
				yield* Latch.open(resume);
				return yield* Fiber.join(collected);
			}).pipe(Effect.provide(scripted)),
		);
		expect(events[0]?.type).toBe("agent_start");
		expect(events.at(-1)?.type).toBe("agent_end");
	});

	it("stream fails with AgentBusy while another run is going, without that run's events", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const agent = yield* agentWith([held(started)]);
				yield* Effect.forkChild(agent.prompt("first"), { startImmediately: true });
				yield* started.await;
				const failure = yield* Effect.flip(Stream.runCollect(agent.stream("second")));
				yield* agent.abort;
				yield* agent.waitForIdle;
				return failure;
			}).pipe(Effect.provide(scripted)),
		);
		expect(result._tag).toBe("AgentBusy");
	});

	it("subscribe gives the events of every run until its scope closes", async () => {
		const events = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
				const events = yield* agent.subscribe;
				yield* agent.prompt("first");
				yield* agent.prompt("second");
				const ends = (event: AgentEvent) => event.type === "agent_end";
				return yield* Stream.runCollect(Stream.take(Stream.filter(events, ends), 2));
			}).pipe(Effect.provide(scripted)),
		);
		expect(events).toHaveLength(2);
	});

	it("subscribe's Stream ends when its scope closes", async () => {
		const ended = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("one")]);
				const scope = yield* Scope.make();
				const events = yield* Scope.provide(agent.subscribe, scope);
				yield* agent.prompt("first");
				yield* Scope.close(scope, Exit.void);
				return yield* Stream.runCollect(events);
			}).pipe(Effect.provide(scripted)),
		);
		expect(ended.at(-1)?.type).toBe("agent_end");
	});
});

describe("the queues and settings", () => {
	it("steering waits in its queue until cleared", async () => {
		const queued = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([]);
				yield* agent.steer(user("steer"));
				yield* agent.followUp(user("later"));
				yield* agent.setSteeringMode("all");
				yield* agent.setFollowUpMode("all");
				const before = yield* agent.peekQueuedMessages;
				yield* agent.clearSteeringQueue;
				const afterSteering = yield* agent.peekQueuedMessages;
				yield* agent.clearFollowUpQueue;
				yield* agent.steer(user("again"));
				yield* agent.clearAllQueues;
				return { before, afterSteering, after: yield* agent.hasQueuedMessages };
			}).pipe(Effect.provide(scripted)),
		);
		expect(queued.before).toMatchObject([{ content: [{ text: "steer" }] }]);
		expect(queued.afterSteering).toMatchObject([{ content: [{ text: "later" }] }]);
		expect(queued.after).toBe(false);
	});

	it("sets the model, thinking level, tools and transcript, and reset keeps the system message", async () => {
		const states = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([], { initialState: { systemPrompt: "Be brief." } });
				const other = { ...(yield* model), id: "faux-2" };
				yield* agent.setModel(other);
				yield* agent.setThinkingLevel("high");
				yield* agent.setTools([Add]);
				yield* agent.setMessages([user("a"), user("b")]);
				const set = yield* agent.state;
				yield* agent.reset;
				return { set, reset: yield* agent.state };
			}).pipe(Effect.provide(scripted)),
		);
		expect(states.set.model.id).toBe("faux-2");
		expect(states.set.thinkingLevel).toBe("high");
		expect(states.set.tools.map((tool) => tool.name)).toEqual(["add"]);
		expect(roles(states.set.messages)).toEqual(["user", "user"]);
		expect(roles(states.reset.messages)).toEqual([]);
	});

	it("takes a snapshot of the transcript, which a later run does not change", async () => {
		const lengths = await runTest(
			Effect.gen(function* () {
				const agent = yield* agentWith([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
				yield* agent.prompt("one");
				const before = yield* agent.state;
				yield* agent.prompt("two");
				return [before.messages.length, (yield* agent.state).messages.length];
			}).pipe(Effect.provide(scripted)),
		);
		expect(lengths).toEqual([2, 4]);
	});
});

describe("the hooks", () => {
	it("are asked as Effects: transformContext, getApiKey, finishTurn and prepareNextTurn", async () => {
		const asked = await runTest(
			Effect.gen(function* () {
				const seen: string[] = [];
				// Records that a hook was asked, and answers with `value`.
				const note = <A>(entry: string, value: A) =>
					Effect.sync(() => {
						seen.push(entry);
						return value;
					});
				const agent = yield* agentWith(
					[
						fauxAssistantMessage([fauxToolCall("add", { a: 1, b: 1 })], { stopReason: "toolUse" }),
						fauxAssistantMessage("2"),
					],
					{
						initialState: { tools: [Add] },
						transformContext: (messages) => note("transformContext", messages),
						getApiKey: (provider) => note(`getApiKey ${provider}`, undefined),
						finishTurn: () => note("finishTurn", undefined),
						prepareNextTurn: (turn) => note(`prepareNextTurn ${turn.toolResults.length}`, undefined),
						afterToolCall: ({ result }) =>
							Effect.succeed({
								content: [{ type: "text" as const, text: `sum ${JSON.stringify(result.content)}` }],
							}),
					},
				);
				yield* agent.prompt("1 + 1?");
				const { messages } = yield* agent.state;
				return { seen, result: messages.find((message) => message.role === "toolResult") };
			}).pipe(Effect.provide(scripted)),
		);
		expect(asked.seen).toEqual([
			"transformContext",
			"getApiKey faux",
			"finishTurn",
			"prepareNextTurn 1",
			"transformContext",
			"getApiKey faux",
			"finishTurn",
		]);
		expect(asked.result).toMatchObject({ content: [{ text: expect.stringContaining("sum") }] });
	});
});
