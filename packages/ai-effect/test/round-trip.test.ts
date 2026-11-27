import { Effect, Layer, Schema, type Scope, Stream } from "effect";
import { LanguageModel, type Prompt, Tool, Toolkit } from "effect/ai";
import { describe, expect, it } from "vitest";
import { EffectProvider, fromPiModelRef, ModelId, Models, PiLanguageModel, ProviderId } from "../src/index.ts";
import { ScriptedLanguageModel, type ScriptedResponse } from "../src/testing/index.ts";

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
});

const LookupToolkit = Toolkit.make(Lookup);

const usage = {
	inputTokens: { uncached: 10, total: 15, cacheRead: 5, cacheWrite: 0 },
	outputTokens: { total: 7, text: 4, reasoning: 3 },
};

const scriptedAnswer: ScriptedResponse = Effect.succeed([
	{ type: "reasoning", text: "hmm" },
	{ type: "text", text: "Hello world" },
	{ type: "tool-call", id: "call-1", name: "lookup", params: { id: "42" } },
	{ type: "response-metadata", id: "resp-1", modelId: "scripted-2026" },
	{ type: "finish", reason: "tool-calls", usage },
]);

/**
 * Effect over Pi over Effect: a `LanguageModel` served by a pi-ai model of a `Models` whose provider runs the
 * scripted `LanguageModel`. Runs `program` against the outer model and returns what the scripted one was asked.
 */
function roundTrip<A, E>(program: Effect.Effect<A, E, LanguageModel.LanguageModel | Scope.Scope>) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const scripted = yield* ScriptedLanguageModel;
				const provider = yield* EffectProvider.make({
					id: ProviderId.make("effect"),
					models: [{ id: ModelId.make("scripted"), contextWindow: 1000, maxTokens: 100 }],
					layer: Layer.succeed(LanguageModel.LanguageModel, yield* LanguageModel.LanguageModel),
				});
				const outer = PiLanguageModel.layer(fromPiModelRef({ provider: "effect", modelId: "scripted" })).pipe(
					Layer.provide(Models.layer([provider])),
				);
				const result = yield* Effect.provide(program, outer);
				return { result, requests: yield* scripted.requests };
			}).pipe(Effect.provide(ScriptedLanguageModel.layer([scriptedAnswer]))),
		),
	);
}

function texts(prompt: Prompt.Prompt): unknown[] {
	return prompt.content.map((message) =>
		message.role === "system"
			? [message.role, message.content]
			: [message.role, message.content.map((part) => (part.type === "text" ? part.text : part.type))],
	);
}

describe("PiLanguageModel over EffectProvider", () => {
	it("generateText returns what the scripted model said", async () => {
		const { result: response, requests } = await roundTrip(
			Effect.gen(function* () {
				return yield* LanguageModel.generateText({
					prompt: [
						{ role: "system", content: "Be brief." },
						{ role: "user", content: "hi" },
					],
					toolkit: yield* LookupToolkit,
					disableToolCallResolution: true,
				});
			}).pipe(Effect.provide(LookupToolkit.toLayer({ lookup: () => Effect.succeed({ title: "unused" }) }))),
		);
		expect(response.text).toBe("Hello world");
		expect(response.reasoningText).toBe("hmm");
		expect(response.toolCalls.map((call) => [call.id, call.name, call.params])).toEqual([
			["call-1", "lookup", { id: "42" }],
		]);
		expect(response.finishReason).toBe("tool-calls");
		expect(response.usage.inputTokens).toEqual(usage.inputTokens);
		expect(response.usage.outputTokens).toEqual(usage.outputTokens);
		const metadata = response.content.filter((part) => part.type === "response-metadata");
		expect(metadata.map((part) => [part.id, part.modelId])).toEqual([["resp-1", "scripted-2026"]]);
		// The scripted model got the same prompt and the same tool declaration the outer model was given.
		expect(requests).toHaveLength(1);
		expect(texts(requests[0].prompt)).toEqual([
			["system", "Be brief."],
			["user", ["hi"]],
		]);
		expect(requests[0].tools.map((tool) => [tool.name, Tool.getDescription(tool), Tool.getJsonSchema(tool)])).toEqual(
			[["lookup", "Look a record up by id", Tool.getJsonSchema(Lookup)]],
		);
	});

	it("streamText returns the same deltas the scripted model streamed", async () => {
		const { result: parts } = await roundTrip(
			Stream.runCollect(
				LanguageModel.streamText({ prompt: "hi", disableToolCallResolution: true, toolCallValidation: "deferred" }),
			),
		);
		expect(
			parts.flatMap((part) => {
				switch (part.type) {
					case "text-delta":
					case "reasoning-delta":
					case "tool-params-delta":
						return [`${part.type} ${part.delta}`];
					case "tool-call":
						return [`${part.type} ${part.id} ${part.name} ${JSON.stringify(part.params)}`];
					case "finish":
						return [`${part.type} ${part.reason} ${JSON.stringify(part.usage)}`];
					default:
						return [];
				}
			}),
		).toEqual([
			"reasoning-delta hmm",
			"text-delta Hell",
			"text-delta o wo",
			"text-delta rld",
			'tool-params-delta {"id',
			'tool-params-delta ":"4',
			'tool-params-delta 2"}',
			'tool-call call-1 lookup {"id":"42"}',
			`finish tool-calls ${JSON.stringify(usage)}`,
		]);
	});
});
