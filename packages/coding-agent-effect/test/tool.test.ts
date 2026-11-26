import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Tool } from "../src/index.ts";
import { openSession, services, texts } from "./scripted.ts";

const lookup = Tool.make("lookup", {
	label: "Lookup",
	description: "Looks a record up.",
	promptSnippet: "Look records up by id",
	promptGuidelines: ["Look a record up before quoting it."],
	exposure: "direct",
	namespace: { name: "records", description: "The record store." },
	annotations: { readOnlyHint: true },
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	handler: ({ id }) =>
		id === "gone" ? Effect.succeed(Tool.error(`No record ${id}`)) : Effect.succeed({ title: `Record ${id}` }),
});

describe("Tool.make", () => {
	it("builds Pi's tool definition with the session fields passed on and the parameters' JSON Schema", async () => {
		const definition = await runTest(lookup.definition);
		expect(definition).toMatchObject({
			name: "lookup",
			label: "Lookup",
			promptSnippet: "Look records up by id",
			promptGuidelines: ["Look a record up before quoting it."],
			exposure: "direct",
			namespace: { name: "records" },
			annotations: { readOnlyHint: true },
			parameters: { type: "object", required: ["id"] },
		});
	});

	it("answers the model with the success value as JSON, or with an error result the handler chose", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession({
					extensions: [Extension.make("records", { tools: [lookup] })],
				});
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("lookup", { id: "7" }), fauxToolCall("lookup", { id: "gone" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Looked up."),
				]);
				yield* session.prompt("Look up 7 and gone.");
				const messages = yield* session.messages;
				return {
					texts: texts(messages, "toolResult"),
					errors: messages.flatMap((message) => (message.role === "toolResult" ? [message.isError] : [])),
					listed: (yield* session.getAllTools()).find((tool) => tool.name === "lookup")?.namespace?.name,
				};
			}).pipe(Effect.provide(services)),
		);
		expect(results).toEqual({
			texts: ['{"title":"Record 7"}', "No record gone"],
			errors: [false, true],
			listed: "records",
		});
	});

	it("is a session's custom tool too, without an extension", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const { session } = yield* openSession({ customTools: [lookup] });
				return yield* session.getActiveToolNames();
			}).pipe(Effect.provide(services)),
		);
		expect(names).toContain("lookup");
	});
});
