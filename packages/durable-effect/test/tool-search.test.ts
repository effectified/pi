import { getCurrentTools } from "@earendil-works/pi-ai";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Tool } from "../src/index.ts";
import { answer, TestHarness, toolCall } from "../src/testing/index.ts";
import { extension, TOOL_SEARCH_TOOL_NAME, tool } from "../src/tool-search.ts";

const Weather = Tool.make("weather", {
	description: "The weather forecast for a city.",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.String,
	deferred: true,
	handler: ({ city }) => Effect.succeed(`Sunny in ${city}.`),
});

describe("tool search", () => {
	it("is Pi's extension and tool: the model loads a deferred tool, and is offered it from its next call", async () => {
		const offered: string[][] = [];
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("What is the weather?");
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tools: [Weather] }), extension],
						responses: [
							(context) => {
								offered.push(getCurrentTools(context.messages).map((offer) => offer.name));
								return toolCall(TOOL_SEARCH_TOOL_NAME, { query: "weather forecast" });
							},
							(context) => {
								offered.push(getCurrentTools(context.messages).map((offer) => offer.name));
								return answer("Sunny.");
							},
						],
					}),
				),
			),
		);
		expect(offered).toEqual([[TOOL_SEARCH_TOOL_NAME], [TOOL_SEARCH_TOOL_NAME, "weather"]]);
		expect([extension.name, tool.name]).toEqual([createToolSearchExtension().name, TOOL_SEARCH_TOOL_NAME]);
	});
});
