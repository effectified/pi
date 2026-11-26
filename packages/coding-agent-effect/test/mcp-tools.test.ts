import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, McpTools } from "../src/index.ts";
import { connected } from "./mcp-server.ts";
import { openSession, services, texts } from "./scripted.ts";

describe("McpTools.tools", () => {
	it("gives the server's tools as Pi names, groups and describes them", async () => {
		const definitions = await runTest(
			Effect.gen(function* () {
				const client = yield* connected;
				const tools = yield* McpTools.tools(client, { server: "docs", description: "The docs server." });
				return yield* Effect.forEach(tools, (tool) => tool.definition);
			}),
		);
		expect(definitions.map((definition) => definition.name)).toEqual(["mcp__docs__search", "mcp__docs__fail"]);
		expect(definitions[0]).toMatchObject({
			label: "docs/search",
			description: "Searches the docs.",
			exposure: "direct",
			namespace: {
				name: "mcp__docs",
				aliases: ["docs"],
				description: "The docs server.",
				instructions: "Search before answering.",
			},
			annotations: { readOnlyHint: true },
			parameters: { type: "object", required: ["query"] },
		});
	});

	it("calls the server for the model, as Pi's MCP extension gives the results", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const client = yield* connected;
				const tools = yield* McpTools.tools(client, { server: "docs" });
				const { session, models } = yield* openSession({ extensions: [Extension.make("docs", { tools })] });
				yield* models.setResponses([
					fauxAssistantMessage(
						[fauxToolCall("mcp__docs__search", { query: "streams" }), fauxToolCall("mcp__docs__fail", {})],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Searched."),
				]);
				yield* session.prompt("Search the docs.");
				const messages = yield* session.messages;
				return {
					texts: texts(messages, "toolResult"),
					structured: messages.flatMap((message) =>
						message.role === "toolResult" ? [[message.isError, message.details]] : [],
					),
				};
			}).pipe(Effect.provide(services)),
		);
		expect(results.texts).toEqual(["Found: streams", "MCP tool docs/fail returned an error"]);
		expect(results.structured).toEqual([
			[false, { server: "docs", tool: "search" }],
			[true, { server: "docs", tool: "fail" }],
		]);
	});
});
