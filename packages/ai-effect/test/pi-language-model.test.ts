import type { AssistantMessage, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import { describe, expect, it } from "vitest";
import { fromPiModelRef, PiLanguageModel } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, ScriptedModels } from "../src/testing/index.ts";

// Equal bounds make every delta four characters, so the stream parts are exact.
const scripted = () => ScriptedModels.layer({ tokenSize: { min: 1, max: 1 } });

const piModel = (options?: PiLanguageModel.Options) =>
	PiLanguageModel.layer(fromPiModelRef({ provider: "faux", modelId: "faux-1" }), options).pipe(
		Layer.provideMerge(scripted()),
	);

/** A scripted response that keeps the transcript and options of the request that took it. */
function recording(message: AssistantMessage) {
	const seen: { context?: TranscriptContext; options?: SimpleStreamOptions } = {};
	const response = (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
		seen.context = context;
		seen.options = options;
		return message;
	};
	return { response, seen };
}

const GetWeather = Tool.make("GetWeather", {
	description: "The weather of a city on a day",
	parameters: Schema.Struct({ city: Schema.String, on: Schema.Date }),
	success: Schema.Struct({ temperature: Schema.Number }),
});

const WeatherToolkit = Toolkit.make(GetWeather);

const getWeatherDeclaration = {
	name: "GetWeather",
	description: "The weather of a city on a day",
	parameters: {
		type: "object",
		properties: { city: { type: "string" }, on: { type: "string" } },
		required: ["city", "on"],
		additionalProperties: true,
	},
};

const anyTimestamp = expect.any(Number);

describe("PiLanguageModel.layer: generateText", () => {
	it("returns text, reasoning, finish reason and usage, and sends the prompt as a pi-ai context", async () => {
		const answer = recording(fauxAssistantMessage([fauxThinking("thinking it over"), fauxText("It is sunny.")]));
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([answer.response]);
				return yield* LanguageModel.generateText({
					prompt: [
						{ role: "system", content: "Be brief." },
						{ role: "user", content: "Weather?" },
					],
				});
			}).pipe(Effect.provide(piModel())),
		);
		expect(response.text).toBe("It is sunny.");
		expect(response.reasoningText).toBe("thinking it over");
		expect(response.finishReason).toBe("stop");
		// The faux provider counts a token per four characters: the prompt is 31 characters, the answer 29.
		expect(response.usage.inputTokens).toEqual({ uncached: 8, total: 8, cacheRead: 0, cacheWrite: 0 });
		expect(response.usage.outputTokens).toEqual({ total: 8, text: undefined, reasoning: undefined });
		expect(answer.seen.context?.messages).toEqual([
			{ role: "system", content: "Be brief.", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "Weather?" }], timestamp: anyTimestamp },
		]);
		// A request without tools leaves the tool choice to the provider.
		expect(answer.seen.options?.toolChoice).toBeUndefined();
	});

	it("declares the toolkit's tools with their JSON Schema and resolves a call with decoded parameters", async () => {
		const call = recording(
			fauxAssistantMessage(
				fauxToolCall("GetWeather", { city: "Paris", on: "2026-11-24T00:00:00.000Z" }, { id: "call-1" }),
				{ stopReason: "toolUse" },
			),
		);
		const received: { city: string; on: Date }[] = [];
		const handlers = WeatherToolkit.toLayer({
			GetWeather: (params) =>
				Effect.sync(() => {
					received.push(params);
					return { temperature: 21 };
				}),
		});
		const response = await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([call.response]);
				return yield* LanguageModel.generateText({ prompt: "Weather in Paris?", toolkit: yield* WeatherToolkit });
			}).pipe(Effect.provide(Layer.merge(piModel(), handlers))),
		);
		expect(call.seen.context?.messages).toEqual([
			{ role: "system", content: "", toolsAdded: [getWeatherDeclaration], timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }], timestamp: anyTimestamp },
		]);
		expect(call.seen.options?.toolChoice).toBe("auto");
		expect(response.finishReason).toBe("tool-calls");
		expect(response.toolCalls.map((toolCall) => [toolCall.id, toolCall.name, toolCall.providerExecuted])).toEqual([
			["call-1", "GetWeather", false],
		]);
		// The handler got the parameters decoded through the tool's schema: the day is a Date.
		expect(received).toEqual([{ city: "Paris", on: new Date("2026-11-24T00:00:00.000Z") }]);
		expect(received[0].on).toBeInstanceOf(Date);
		expect(response.toolResults.map((result) => [result.id, result.isFailure, result.result])).toEqual([
			["call-1", false, { temperature: 21 }],
		]);
	});

	it("sends assistant tool calls, tool results and later system messages of the prompt", async () => {
		const answer = recording(fauxAssistantMessage("21 degrees."));
		const api = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				yield* models.setResponses([answer.response]);
				yield* LanguageModel.generateText({
					prompt: [
						{ role: "user", content: "Weather in Paris?" },
						{
							role: "assistant",
							content: [
								{ type: "reasoning", text: "I need the tool." },
								{ type: "text", text: "Let me check." },
								{ type: "tool-call", id: "call-1", name: "GetWeather", params: { city: "Paris" } },
							],
						},
						{
							role: "tool",
							content: [
								{
									type: "tool-result",
									id: "call-1",
									name: "GetWeather",
									isFailure: false,
									result: { temperature: 21 },
								},
							],
						},
						{ role: "system", content: "Answer in Celsius." },
						{
							role: "user",
							content: [
								{ type: "text", text: "And this picture?" },
								{ type: "file", mediaType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" },
								{ type: "file", mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) },
							],
						},
					],
				});
				return models.model.api;
			}).pipe(Effect.provide(piModel())),
		);
		expect(answer.seen.context?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }], timestamp: anyTimestamp },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "I need the tool." },
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", id: "call-1", name: "GetWeather", arguments: { city: "Paris" } },
				],
				// An assistant message of the prompt is attributed to the model it is sent to.
				api,
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: anyTimestamp,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "GetWeather",
				content: [{ type: "text", text: '{"temperature":21}' }],
				isError: false,
				timestamp: anyTimestamp,
			},
			{ role: "system", content: "Answer in Celsius.", timestamp: anyTimestamp },
			{
				role: "user",
				content: [
					{ type: "text", text: "And this picture?" },
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "image", mimeType: "image/jpeg", data: "AQID" },
				],
				timestamp: anyTimestamp,
			},
		]);
	});

	it("sends the layer's pi-ai options with every request", async () => {
		const answer = recording(fauxAssistantMessage("ok"));
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([answer.response]);
				return yield* LanguageModel.generateText({ prompt: "hi" });
			}).pipe(Effect.provide(piModel({ reasoning: "high", maxTokens: 64, sessionId: "s-1" }))),
		);
		expect([answer.seen.options?.reasoning, answer.seen.options?.maxTokens, answer.seen.options?.sessionId]).toEqual([
			"high",
			64,
			"s-1",
		]);
	});

	it("fails with an AiError that carries pi-ai's error text", async () => {
		const error = await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([
					fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }),
				]);
				return yield* Effect.flip(LanguageModel.generateText({ prompt: "hi" }));
			}).pipe(Effect.provide(piModel())),
		);
		expect(error._tag).toBe("AiError");
		expect(error.reason._tag).toBe("UnknownError");
		expect(error.message).toBe("PiLanguageModel.generateText: overloaded");
	});

	it("fails without a request for what pi-ai cannot be asked", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const models = yield* ScriptedModels;
				const toolkit = yield* WeatherToolkit;
				const forced = yield* Effect.flip(
					LanguageModel.generateText({ prompt: "hi", toolkit, toolChoice: "required" }),
				);
				const structured = yield* Effect.flip(
					LanguageModel.generateObject({ prompt: "hi", schema: Schema.Struct({ answer: Schema.String }) }),
				);
				const file = yield* Effect.flip(
					LanguageModel.generateText({
						prompt: [
							{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "JVBERi0=" }] },
						],
					}),
				);
				return { forced, structured, file, calls: yield* models.callCount };
			}).pipe(
				Effect.provide(
					Layer.merge(piModel(), WeatherToolkit.toLayer({ GetWeather: () => Effect.succeed({ temperature: 0 }) })),
				),
			),
		);
		expect(result.forced.reason._tag).toBe("InvalidRequestError");
		expect(result.forced.message).toContain("parameter 'toolChoice'");
		expect(result.structured.reason._tag).toBe("InvalidRequestError");
		expect(result.structured.message).toContain("parameter 'responseFormat'");
		expect(result.file.reason._tag).toBe("InvalidRequestError");
		expect(result.file.message).toContain("not a application/pdf file");
		expect(result.calls).toBe(0);
	});

	it("aborts the pi-ai request when the fiber is interrupted", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				let report: (signal: AbortSignal | undefined) => void = () => {};
				const started = new Promise<AbortSignal | undefined>((resolve) => {
					report = resolve;
				});
				yield* (yield* ScriptedModels).setResponses([
					(_context, options) => {
						report(options?.signal);
						return new Promise<AssistantMessage>(() => {});
					},
				]);
				const fiber = yield* Effect.forkChild(LanguageModel.generateText({ prompt: "hi" }));
				const signal = yield* Effect.promise(() => started);
				yield* Fiber.interrupt(fiber);
				return { signal, exit: yield* Effect.exit(Fiber.join(fiber)) };
			}).pipe(Effect.provide(piModel())),
		);
		expect(result.signal?.aborted).toBe(true);
		expect(Exit.hasInterrupts(result.exit)).toBe(true);
	});
});

describe("PiLanguageModel.layer: streamText", () => {
	it("streams reasoning, text, a tool call, the finish reason and usage as stream parts", async () => {
		const parts = await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([
					fauxAssistantMessage(
						[
							fauxThinking("hmm"),
							fauxText("Hello world"),
							fauxToolCall("GetWeather", { city: "Paris", on: "2026-11-24T00:00:00.000Z" }, { id: "call-1" }),
						],
						{ stopReason: "toolUse", responseId: "resp-1" },
					),
				]);
				return yield* Stream.runCollect(
					LanguageModel.streamText({
						prompt: "Weather in Paris?",
						toolkit: yield* WeatherToolkit,
						disableToolCallResolution: true,
					}),
				);
			}).pipe(
				Effect.provide(
					Layer.merge(piModel(), WeatherToolkit.toLayer({ GetWeather: () => Effect.succeed({ temperature: 0 }) })),
				),
			),
		);
		expect(
			parts.map((part) => {
				switch (part.type) {
					case "text-delta":
					case "reasoning-delta":
					case "tool-params-delta":
						return `${part.type} ${part.id} ${part.delta}`;
					case "text-start":
					case "text-end":
					case "reasoning-start":
					case "reasoning-end":
					case "tool-params-end":
						return `${part.type} ${part.id}`;
					case "tool-params-start":
						return `${part.type} ${part.id} ${part.name}`;
					case "tool-call":
						return `${part.type} ${part.id} ${part.name} ${JSON.stringify(part.params)}`;
					case "response-metadata":
						return `${part.type} ${part.id} ${part.modelId}`;
					case "finish":
						return `${part.type} ${part.reason}`;
					default:
						return part.type;
				}
			}),
		).toEqual([
			"reasoning-start 0",
			"reasoning-delta 0 hmm",
			"reasoning-end 0",
			"text-start 1",
			"text-delta 1 Hell",
			"text-delta 1 o wo",
			"text-delta 1 rld",
			"text-end 1",
			"tool-params-start call-1 GetWeather",
			'tool-params-delta call-1 {"ci',
			'tool-params-delta call-1 ty":',
			'tool-params-delta call-1 "Par',
			'tool-params-delta call-1 is",',
			'tool-params-delta call-1 "on"',
			'tool-params-delta call-1 :"20',
			"tool-params-delta call-1 26-1",
			"tool-params-delta call-1 1-24",
			"tool-params-delta call-1 T00:",
			"tool-params-delta call-1 00:0",
			"tool-params-delta call-1 0.00",
			'tool-params-delta call-1 0Z"}',
			"tool-params-end call-1",
			'tool-call call-1 GetWeather {"city":"Paris","on":"2026-11-24T00:00:00.000Z"}',
			"response-metadata resp-1 faux-1",
			"finish tool-calls",
		]);
		const finish = parts[parts.length - 1];
		// The faux provider's estimate: the prompt (tool declaration and question) and the scripted answer.
		expect(finish.type === "finish" && finish.usage.inputTokens).toEqual({
			uncached: 63,
			total: 63,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(finish.type === "finish" && finish.usage.outputTokens.total).toBe(19);
	});

	it("fails the stream with an AiError after the parts that arrived", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* (yield* ScriptedModels).setResponses([
					fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "connection lost" }),
				]);
				const seen: string[] = [];
				const error = yield* Effect.flip(
					Stream.runForEach(LanguageModel.streamText({ prompt: "hi" }), (part) =>
						Effect.sync(() => seen.push(part.type)),
					),
				);
				return { seen, error };
			}).pipe(Effect.provide(piModel())),
		);
		expect(result.seen).toEqual(["text-start", "text-delta", "text-delta", "text-end"]);
		expect(result.error.reason._tag).toBe("UnknownError");
		expect(result.error.message).toBe("PiLanguageModel.streamText: connection lost");
	});
});

describe("PiLanguageModel.layer", () => {
	it("fails with ModelNotFound when Models does not list the model", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				LanguageModel.generateText({ prompt: "hi" }).pipe(
					Effect.provide(
						PiLanguageModel.layer(fromPiModelRef({ provider: "faux", modelId: "missing" })).pipe(
							Layer.provide(scripted()),
						),
					),
				),
			),
		);
		expect(error._tag).toBe("ModelNotFound");
		expect(error.message).toBe('No chat model "missing" is registered for provider "faux"');
	});
});
