import { Effect, Stream } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import { describe, expect, it } from "vitest";
import { ScriptedLanguageModel } from "../src/testing/index.ts";

describe("ScriptedLanguageModel.layer", () => {
	it("returns a queued response's parts from generateText", async () => {
		const response = await Effect.runPromise(
			LanguageModel.generateText({ prompt: "hi" }).pipe(
				Effect.provide(
					ScriptedLanguageModel.layer([
						Effect.succeed([
							{ type: "reasoning", text: "hmm" },
							{ type: "text", text: "Hello world" },
							{
								type: "finish",
								reason: "stop",
								usage: { inputTokens: { total: 6 }, outputTokens: { total: 3 } },
							},
						]),
					]),
				),
			),
		);
		expect(response.text).toBe("Hello world");
		expect(response.reasoningText).toBe("hmm");
		expect(response.finishReason).toBe("stop");
		expect(response.usage.inputTokens.total).toBe(6);
		expect(response.usage.outputTokens.total).toBe(3);
	});

	it("streams text, reasoning and tool call parameters four characters a delta", async () => {
		const parts = await Effect.runPromise(
			LanguageModel.streamText({
				prompt: "hi",
				disableToolCallResolution: true,
				toolCallValidation: "deferred",
			}).pipe(
				Stream.runCollect,
				Effect.provide(
					ScriptedLanguageModel.layer([
						Effect.succeed([
							{ type: "reasoning", text: "hmm" },
							{ type: "text", text: "Hello world" },
							{ type: "tool-call", id: "call-1", name: "lookup", params: { id: "42" } },
						]),
					]),
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
					case "tool-params-start":
					case "tool-params-end":
					case "tool-call":
						return `${part.type} ${part.id}`;
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
			"tool-params-start call-1",
			'tool-params-delta call-1 {"id',
			'tool-params-delta call-1 ":"4',
			'tool-params-delta call-1 2"}',
			"tool-params-end call-1",
			"tool-call call-1",
		]);
	});

	it("records what each request asked and takes responses in order", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedLanguageModel;
				yield* scripted.setResponses([Effect.succeed([{ type: "text", text: "one" }])]);
				yield* scripted.appendResponses([Effect.succeed([{ type: "text", text: "two" }])]);
				const first = yield* LanguageModel.generateText({ prompt: "first" });
				const second = yield* LanguageModel.generateText({ prompt: [{ role: "user", content: "second" }] });
				const requests = yield* scripted.requests;
				return {
					texts: [first.text, second.text],
					prompts: requests.map((request) =>
						request.prompt.content.map((message) =>
							message.role === "user"
								? message.content.map((part) => (part.type === "text" ? part.text : ""))
								: [],
						),
					),
				};
			}).pipe(Effect.provide(ScriptedLanguageModel.layer())),
		);
		expect(result).toEqual({ texts: ["one", "two"], prompts: [[["first"]], [["second"]]] });
	});

	it("fails a request with the scripted error, and one with nothing queued", async () => {
		const scriptedFailure = AiError.make({
			module: "Test",
			method: "request",
			reason: new AiError.UnknownError({ description: "rate limited" }),
		});
		const errors = await Effect.runPromise(
			Effect.gen(function* () {
				const failed = yield* Effect.flip(LanguageModel.generateText({ prompt: "hi" }));
				const empty = yield* Effect.flip(LanguageModel.generateText({ prompt: "hi" }));
				return { failed, empty };
			}).pipe(Effect.provide(ScriptedLanguageModel.layer([Effect.fail(scriptedFailure)]))),
		);
		expect(errors.failed).toBe(scriptedFailure);
		expect(errors.empty.reason._tag).toBe("UnknownError");
		expect(errors.empty.message).toContain("No scripted response is queued for request 2");
	});
});
