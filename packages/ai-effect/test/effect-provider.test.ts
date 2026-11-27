import {
	type AssistantMessageEvent,
	normalizeContext,
	type Context as PiContext,
	type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { describe, expect, it } from "vitest";
import { complete, EffectProvider, ModelId, Models, ProviderId, streamSimple } from "../src/index.ts";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	ScriptedLanguageModel,
	type ScriptedResponse,
} from "../src/testing/index.ts";

const MODEL: EffectProvider.EffectModel = {
	id: ModelId.make("scripted"),
	contextWindow: 1000,
	maxTokens: 100,
	input: ["text", "image"],
	cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 },
};

const lookup: PiTool = {
	name: "lookup",
	description: "Look a record up by id",
	parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

const context: PiContext = {
	systemPrompt: "Be brief.",
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
	tools: [lookup],
};

/** A provider over `layer` and a pi-ai `Models` that holds it, alive until the scope closes. */
const provide = Effect.fnUntraced(function* (layer: Layer.Layer<LanguageModel.LanguageModel>) {
	const provider = yield* EffectProvider.make({ id: ProviderId.make("effect"), models: [MODEL], layer });
	const models = yield* Effect.provide(
		Models.use((models) => Effect.succeed(models)),
		Models.layer([provider]),
	);
	return { provider, models, model: provider.getModels()[0] };
});

/** `provide` over a scripted effect/ai model, with the model's controls. */
const provideScripted = Effect.fnUntraced(function* (responses: ReadonlyArray<ScriptedResponse>) {
	const services = yield* Layer.build(ScriptedLanguageModel.layer(responses));
	return {
		...(yield* provide(Layer.succeedContext(services))),
		scripted: Context.get(services, ScriptedLanguageModel),
	};
});

/** `provide` over a model that streams exactly `parts`. */
const provideParts = (parts: ReadonlyArray<Response.StreamPartEncoded>) =>
	provide(
		Layer.effect(
			LanguageModel.LanguageModel,
			LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.fromIterable(parts) }),
		),
	);

function collect(events: AsyncIterable<AssistantMessageEvent>): Effect.Effect<AssistantMessageEvent[]> {
	return Effect.promise(async () => {
		const collected: AssistantMessageEvent[] = [];
		for await (const event of events) collected.push(event);
		return collected;
	});
}

function label(event: AssistantMessageEvent): string {
	switch (event.type) {
		case "start":
			return "start";
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return `${event.type} ${event.contentIndex} ${event.delta}`;
		case "done":
		case "error":
			return `${event.type} ${event.reason}`;
		default:
			return `${event.type} ${event.contentIndex}`;
	}
}

function describePart(part: Prompt.Part): unknown[] {
	switch (part.type) {
		case "text":
		case "reasoning":
			return [part.type, part.text];
		case "file":
			return [part.type, part.mediaType, part.data];
		case "tool-call":
			return [part.type, part.id, part.name, part.params];
		case "tool-result":
			return [part.type, part.id, part.name, part.isFailure, part.result];
		default:
			return [part.type];
	}
}

function describePrompt(prompt: Prompt.Prompt): unknown[] {
	return prompt.content.map((message) =>
		message.role === "system" ? [message.role, message.content] : [message.role, message.content.map(describePart)],
	);
}

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

describe("EffectProvider.make", () => {
	it("gives a pi-ai provider that lists its models and needs no key", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const { provider, models } = yield* provideScripted([]);
				const minimal = yield* EffectProvider.make({
					id: ProviderId.make("plain"),
					name: "Plain",
					models: [{ id: ModelId.make("m"), contextWindow: 8, maxTokens: 4 }],
					layer: ScriptedLanguageModel.layer(),
				});
				return {
					id: provider.id,
					name: provider.name,
					available: yield* Effect.promise(() => models.getAvailable("effect")),
					auth: yield* Effect.promise(() => models.getAuth("effect")),
					minimal: [minimal.name, minimal.getModels()],
				};
			}),
		);
		expect(result.id).toBe("effect");
		expect(result.name).toBe("effect");
		expect(result.available).toEqual([
			{
				id: "scripted",
				name: "scripted",
				api: "effect-ai",
				provider: "effect",
				baseUrl: "effect-ai://layer",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		]);
		expect(result.auth?.auth).toEqual({});
		expect(result.minimal).toEqual([
			"Plain",
			[
				{
					id: "m",
					name: "m",
					api: "effect-ai",
					provider: "plain",
					baseUrl: "effect-ai://layer",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8,
					maxTokens: 4,
				},
			],
		]);
	});

	it("pushes pi-ai's event sequence with a tool call, usage and stop reason, and runs no tool", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const { models, model, scripted } = yield* provideScripted([
					Effect.succeed([
						{ type: "reasoning", text: "hmm" },
						{ type: "text", text: "Hello world" },
						{ type: "tool-call", id: "call-1", name: "lookup", params: { id: "42" } },
						{ type: "response-metadata", id: "resp-1", modelId: "scripted-2026" },
						{
							type: "finish",
							reason: "tool-calls",
							usage: {
								inputTokens: { uncached: 10, total: 15, cacheRead: 5, cacheWrite: 0 },
								outputTokens: { total: 7, text: 4, reasoning: 3 },
							},
						},
					]),
				]);
				const response = models.stream(model, context);
				const events = yield* collect(response);
				const message = yield* Effect.promise(() => response.result());
				return { events, message, requests: yield* scripted.requests };
			}),
		);
		expect(result.events.map(label)).toEqual([
			"start",
			"thinking_start 0",
			"thinking_delta 0 hmm",
			"thinking_end 0",
			"text_start 1",
			"text_delta 1 Hell",
			"text_delta 1 o wo",
			"text_delta 1 rld",
			"text_end 1",
			"toolcall_start 2",
			'toolcall_delta 2 {"id',
			'toolcall_delta 2 ":"4',
			'toolcall_delta 2 2"}',
			"toolcall_end 2",
			"done toolUse",
		]);
		const ended = result.events.filter((event) => event.type === "toolcall_end");
		expect(ended.map((event) => event.toolCall)).toEqual([
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { id: "42" } },
		]);
		expect(result.message).toMatchObject({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Hello world" },
				{ type: "toolCall", id: "call-1", name: "lookup", arguments: { id: "42" } },
			],
			api: "effect-ai",
			provider: "effect",
			model: "scripted",
			responseId: "resp-1",
			responseModel: "scripted-2026",
			stopReason: "toolUse",
			rawStopReason: "tool-calls",
		});
		// pi-ai's cost of the usage at the model's prices per million tokens.
		const cost = { input: (2 / 1000000) * 10, output: (10 / 1000000) * 7, cacheRead: (0.5 / 1000000) * 5 };
		expect(result.message.usage).toEqual({
			input: 10,
			output: 7,
			cacheRead: 5,
			cacheWrite: 0,
			reasoning: 3,
			totalTokens: 22,
			cost: { ...cost, cacheWrite: 0, total: cost.input + cost.output + cost.cacheRead, totalFromProvider: false },
		});
		// The model was asked once, with the tool declared and nothing to run it: the call went to Pi as it came.
		expect(result.requests).toHaveLength(1);
		const request = result.requests[0];
		expect(describePrompt(request.prompt)).toEqual([
			["system", "Be brief."],
			["user", [["text", "hi"]]],
		]);
		expect(request.toolChoice).toBe("auto");
		expect(request.toolCallValidation).toBe("deferred");
		expect(
			request.tools.map((tool) => [
				tool.name,
				Tool.getDescription(tool),
				Tool.getJsonSchema(tool),
				Tool.isClientExecuted(tool),
			]),
		).toEqual([["lookup", "Look a record up by id", lookup.parameters, true]]);
	});

	it("sends the transcript as a prompt: images, tool calls and tool results, without failed turns", async () => {
		const prompt = await scoped(
			Effect.gen(function* () {
				const { model, models, scripted } = yield* provideScripted([
					Effect.succeed([{ type: "text", text: "ok" }]),
				]);
				yield* complete(model, {
					systemPrompt: "Be brief.",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Look" },
								{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
							],
							timestamp: 1,
						},
						fauxAssistantMessage(
							[
								fauxThinking("from another model"),
								fauxText("Checking."),
								fauxToolCall("lookup", { id: "42" }, { id: "call-1" }),
							],
							{ stopReason: "toolUse" },
						),
						{
							role: "toolResult",
							toolCallId: "call-1",
							toolName: "lookup",
							content: [{ type: "text", text: "found" }],
							isError: false,
							timestamp: 3,
						},
						fauxAssistantMessage("half an answer", { stopReason: "error", errorMessage: "connection lost" }),
						{ role: "user", content: "And now?", timestamp: 5 },
					],
				}).pipe(Effect.provideService(Models, models));
				return (yield* scripted.requests)[0].prompt;
			}),
		);
		expect(describePrompt(prompt)).toEqual([
			["system", "Be brief."],
			[
				"user",
				[
					["text", "Look"],
					["file", "image/png", "iVBORw0KGgo="],
				],
			],
			[
				"assistant",
				[
					["text", "Checking."],
					["tool-call", "call-1", "lookup", { id: "42" }],
				],
			],
			["tool", [["tool-result", "call-1", "lookup", false, "found"]]],
			["user", [["text", "And now?"]]],
		]);
	});

	it("serves streamSimple with its tool choice, and a response without a finish part", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const { model, models, scripted } = yield* provideScripted([
					Effect.succeed([{ type: "text", text: "ok" }]),
				]);
				const events = yield* Stream.runCollect(streamSimple(model, context, { toolChoice: "none" })).pipe(
					Effect.provideService(Models, models),
				);
				return { events, toolChoice: (yield* scripted.requests)[0].toolChoice };
			}),
		);
		expect(result.toolChoice).toBe("none");
		expect(result.events.map(label)).toEqual(["start", "text_start 0", "text_delta 0 ok", "text_end 0", "done stop"]);
		const done = result.events[result.events.length - 1];
		expect(done.type === "done" && done.message.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalFromProvider: false },
		});
	});

	it("turns an AiError into pi-ai's error event", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const failure = AiError.make({
					module: "Test",
					method: "request",
					reason: new AiError.UnknownError({ description: "rate limited" }),
				});
				const { model, models } = yield* provideScripted([Effect.fail(failure), Effect.fail(failure)]);
				const events = yield* collect(models.stream(model, context));
				const error = yield* Effect.flip(complete(model, context)).pipe(Effect.provideService(Models, models));
				return { events, error };
			}),
		);
		expect(result.events.map(label)).toEqual(["start", "error error"]);
		const last = result.events[1];
		expect(last.type === "error" && [last.error.stopReason, last.error.errorMessage, last.error.content]).toEqual([
			"error",
			"Test.request: rate limited",
			[],
		]);
		expect(result.error._tag).toBe("ModelRequestError");
		expect(result.error.message).toBe("Test.request: rate limited");
	});

	it("interrupts the Effect fiber when the pi-ai request is aborted", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				let started: () => void = () => {};
				const running = new Promise<void>((resolve) => {
					started = resolve;
				});
				let interrupted = false;
				const { model, models } = yield* provideScripted([
					Effect.sync(started).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								interrupted = true;
							}),
						),
					),
				]);
				const controller = new AbortController();
				const response = models.stream(model, context, { signal: controller.signal });
				yield* Effect.promise(() => running);
				const interruptedBefore = interrupted;
				controller.abort();
				const events = yield* collect(response);
				const message = yield* Effect.promise(() => response.result());
				return { interruptedBefore, interrupted, events, message };
			}),
		);
		expect(result.interruptedBefore).toBe(false);
		expect(result.interrupted).toBe(true);
		expect(result.events.map(label)).toEqual(["start", "error aborted"]);
		expect([result.message.stopReason, result.message.errorMessage]).toEqual(["aborted", "Request was aborted"]);
	});

	it("ends a request whose signal is already aborted", async () => {
		const message = await scoped(
			Effect.gen(function* () {
				const { model, provider } = yield* provideScripted([Effect.never]);
				const controller = new AbortController();
				controller.abort();
				// Straight at the provider, so the request reaches it with its signal already aborted.
				const request = provider.streamSimple(model, normalizeContext(context), { signal: controller.signal });
				return yield* Effect.promise(() => request.result());
			}),
		);
		expect([message.stopReason, message.errorMessage]).toEqual(["aborted", "Request was aborted"]);
	});

	it("interrupts open requests when its scope closes, and aborts later ones", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				let started: () => void = () => {};
				const running = new Promise<void>((resolve) => {
					started = resolve;
				});
				const { model, models } = yield* provideScripted([
					Effect.sync(started).pipe(Effect.andThen(Effect.never)),
				]).pipe(Scope.provide(scope));
				const open = models.stream(model, context);
				yield* Effect.promise(() => running);
				yield* Scope.close(scope, Exit.void);
				const interrupted = yield* Effect.promise(() => open.result());
				const late = yield* Effect.promise(() => models.complete(model, context));
				return [interrupted.stopReason, late.stopReason];
			}),
		);
		expect(result).toEqual(["aborted", "aborted"]);
	});

	it("takes a call without streamed parameters, keeps provider-executed calls from Pi, reports bad arguments", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const { model, models } = yield* provideParts([
					{ type: "tool-call", id: "call-1", name: "lookup", params: { id: "42" } },
					{ type: "tool-params-start", id: "call-2", name: "web_search", providerExecuted: true },
					{ type: "tool-params-delta", id: "call-2", delta: '{"query":"x"}' },
					{ type: "tool-params-end", id: "call-2" },
					{ type: "tool-call", id: "call-2", name: "web_search", params: { query: "x" }, providerExecuted: true },
					{ type: "tool-call", id: "call-3", name: "lookup", params: "not an object" },
					{
						type: "finish",
						reason: "stop",
						usage: { inputTokens: { total: 20, cacheRead: 5, cacheWrite: 3 }, outputTokens: { total: 4 } },
					},
				]);
				const response = models.stream(model, context);
				return { events: yield* collect(response), message: yield* Effect.promise(() => response.result()) };
			}),
		);
		expect(result.events.map(label)).toEqual([
			"start",
			"toolcall_start 0",
			"toolcall_end 0",
			"toolcall_start 1",
			"toolcall_end 1",
			"done toolUse",
		]);
		expect(result.message.content).toEqual([
			{ type: "toolCall", id: "call-1", name: "lookup", arguments: { id: "42" } },
			{
				type: "toolCall",
				id: "call-3",
				name: "lookup",
				arguments: {},
				argumentsError: 'Tool call arguments are not a JSON object: "not an object"',
			},
		]);
		// A model that reports `stop` with a call in hand still stops for tool use; its own word is kept beside it.
		expect([result.message.stopReason, result.message.rawStopReason]).toEqual(["toolUse", "stop"]);
		// Only a total was reported, so the uncached input is what the cache did not read or write.
		expect(result.message.usage).toMatchObject({
			input: 12,
			output: 4,
			cacheRead: 5,
			cacheWrite: 3,
			totalTokens: 24,
		});
	});

	it("ends in pi-ai's error event for an error part and for a filtered response", async () => {
		const result = await scoped(
			Effect.gen(function* () {
				const broken = yield* provideParts([
					{ type: "text-start", id: "0" },
					{ type: "text-delta", id: "0", delta: "half" },
					{ type: "error", error: new Error("stream broke") },
					{ type: "text-delta", id: "0", delta: " never" },
				]);
				const filtered = yield* provideParts([
					{ type: "finish", reason: "content-filter", usage: { inputTokens: { total: 9 }, outputTokens: {} } },
				]);
				return {
					broken: yield* Effect.promise(() => broken.models.complete(broken.model, context)),
					filtered: yield* Effect.promise(() => filtered.models.complete(filtered.model, context)),
				};
			}),
		);
		expect([result.broken.stopReason, result.broken.errorMessage, result.broken.content]).toEqual([
			"error",
			"stream broke",
			[{ type: "text", text: "half" }],
		]);
		expect([result.filtered.stopReason, result.filtered.errorMessage, result.filtered.usage.input]).toEqual([
			"error",
			'The model stopped with finish reason "content-filter"',
			9,
		]);
	});
});
