// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the packages, this file the sources), and the provider is scripted.

import { fauxAssistantMessage, fauxToolCall, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Context, Effect, Fiber, Latch, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Agent, AgentLoop, StreamFn, Tool } from "../src/index.ts";
import { held } from "./scripted.ts";

// README: quick start
// A service of your program. Tool handlers reach it through the Layer you provide.
class Records extends Context.Service<
	Records,
	{ readonly get: (id: string) => Effect.Effect<{ readonly title: string }> }
>()("app/Records") {}

const Lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	handler: ({ id }) => Records.use((records) => records.get(id)), // Effect<{ title }, never, Records>
});

const program = Effect.gen(function* () {
	// No provider and no key: the model answers with these turns, in order.
	const models = yield* ScriptedModels;
	yield* models.setResponses([
		fauxAssistantMessage([fauxToolCall("lookup", { id: "42" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Record 42 is titled Answer."),
	]);
	const agent = yield* Agent.make({
		initialState: { systemPrompt: "You look records up.", model: models.model, tools: [Lookup] },
	});
	yield* agent.prompt("What is record 42 called?");
	const { messages } = yield* agent.state;
	return messages.map((message) => message.role); // ["system", "user", "assistant", "toolResult", "assistant"]
});

const live = Layer.mergeAll(
	// Requests go to the providers of `Models`; here, the scripted one.
	Layer.provideMerge(StreamFn.models, ScriptedModels.layer()),
	Layer.succeed(Records, { get: () => Effect.succeed({ title: "Answer" }) }),
);

describe("the quick start of the README", () => {
	it("runs a prompt with a tool to its answer", async () => {
		const roles = await Effect.runPromise(Effect.scoped(Effect.provide(program, live)));
		expect(roles).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
	});
});

// README: tools
const Search = Tool.make("search", {
	label: "Search",
	description: "Search the records.",
	parameters: Schema.Struct({ query: Schema.String, since: Schema.optional(Schema.Date) }),
	success: Schema.Array(Schema.String),
	handler: ({ query }, api) =>
		Effect.gen(function* () {
			// Progress: Pi emits it as a tool_execution_update event.
			yield* api.update({ content: [{ type: "text", text: `searching ${query}` }], details: undefined });
			if (query === "") return Tool.error("An empty query finds nothing."); // the model reads an error result
			return Tool.result([`${query}-1`, `${query}-2`], { details: { hits: 2 } }); // details for a UI
		}),
});

describe("the tools of the README", () => {
	it("give the model a result, an error result, and progress", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const tool = yield* Search.agentTool;
				const updates: unknown[] = [];
				const found = yield* Effect.promise(() =>
					tool.execute("call-1", { query: "pi" }, undefined, (partial) => updates.push(partial)),
				);
				const empty = yield* Effect.promise(() => tool.execute("call-2", { query: "" }));
				return { found, empty, updates: updates.length };
			}),
		);
		expect(results.found).toEqual({
			content: [{ type: "text", text: '["pi-1","pi-2"]' }],
			details: { hits: 2 },
		});
		expect(results.empty).toMatchObject({ isError: true, content: [{ text: "An empty query finds nothing." }] });
		expect(results.updates).toBe(1);
	});
});

// README: events
const replies = Effect.gen(function* () {
	const agent = yield* Agent.make({ initialState: { model: (yield* ScriptedModels).model } });
	const deltas = agent.stream("Say hello.").pipe(
		Stream.filter((event) => event.type === "message_update"),
		Stream.map((event) => event.assistantMessageEvent),
		Stream.filter((update) => update.type === "text_delta"),
		Stream.map((update) => update.delta),
	);
	return (yield* Stream.runCollect(deltas)).join("");
});

describe("the events of the README", () => {
	it("stream the text of one run's answer", async () => {
		const text = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([fauxAssistantMessage("Hello there.")]));
				return yield* replies;
			}).pipe(Effect.provide(Layer.provideMerge(StreamFn.models, ScriptedModels.layer()))),
		);
		expect(text).toBe("Hello there.");
	});
});

// README: interruption
const bounded = Effect.gen(function* () {
	const agent = yield* Agent.make({ initialState: { model: (yield* ScriptedModels).model } });
	const answered = yield* agent.prompt("Take your time.").pipe(Effect.timeout("30 seconds"), Effect.option);
	return { answered, state: yield* agent.state };
});

describe("the interruption of the README", () => {
	it("aborts a run that outlives its timeout, and the agent is idle after it", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				yield* ScriptedModels.use((models) => models.setResponses([held(started)]));
				const fiber = yield* Effect.forkChild(bounded, { startImmediately: true });
				yield* started.await;
				yield* TestClock.adjust("30 seconds");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(Layer.provideMerge(StreamFn.models, ScriptedModels.layer()))),
		);
		expect(Option.isNone(result.answered)).toBe(true);
		expect(result.state.isStreaming).toBe(false);
		expect(result.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});
});

// README: hooks
const guarded = Agent.make({
	initialState: { tools: [Lookup] },
	// Asked before a tool runs, with validated arguments: a blocked call becomes Pi's error result.
	beforeToolCall: ({ toolCall }) =>
		Effect.succeed(toolCall.name.startsWith("delete") ? { block: true, reason: "read only" } : undefined),
	// Asked after each turn: end the run after the first one.
	finishTurn: () => Effect.succeed({ action: "end" as const }),
});

describe("the hooks of the README", () => {
	it("end the run after the first turn, though the model asked for a tool", async () => {
		const roles = await runTest(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("lookup", { id: "1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("never asked"),
				]);
				const agent = yield* guarded;
				yield* agent.setModel(models.model);
				yield* agent.prompt("Look record 1 up.");
				return (yield* agent.state).messages.map((message) => message.role);
			}).pipe(Effect.provide(live)),
		);
		expect(roles).toEqual(["system", "user", "assistant", "toolResult"]);
	});
});

// README: the low-level loop
const added = Effect.gen(function* () {
	const model = (yield* ScriptedModels).model;
	const prompt = { role: "user" as const, content: [{ type: "text" as const, text: "Hi." }], timestamp: 0 };
	return yield* AgentLoop.run(
		[prompt],
		{ messages: [], tools: [Lookup] },
		{
			model,
			convertToLlm: (messages) => Effect.succeed(messages),
			getSteeringMessages: Effect.succeed([]),
		},
	);
});

describe("the low-level loop of the README", () => {
	it("gives the messages the run added", async () => {
		const messages = await runTest(
			Effect.gen(function* () {
				yield* ScriptedModels.use((models) => models.setResponses([fauxAssistantMessage("Hello.")]));
				return yield* added;
			}).pipe(Effect.provide(live)),
		);
		expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});
});

describe("where requests go, in the README", () => {
	it("builds a proxy's Layer", () => {
		// README: where requests go
		const proxied = StreamFn.proxy({
			proxyUrl: "https://genai.example.com",
			authToken: Effect.succeed("token"), // or an Effect that refreshes it
		});
		expect(Layer.isLayer(proxied)).toBe(true);
	});
});
