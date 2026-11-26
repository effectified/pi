import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Command, CommandContext, Extension, ExtensionContext, Tool, ToolContext } from "../src/index.ts";
import { openSession, services, texts } from "./scripted.ts";

const echo = Tool.make("echo", {
	label: "Echo",
	description: "Echoes its text.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	handler: ({ text }) => Effect.succeed(`echo: ${text}`),
});

const inspect = Tool.make("inspect", {
	label: "Inspect",
	description: "Reports what its context says.",
	parameters: Schema.Struct({}),
	success: Schema.Struct({
		cwd: Schema.String,
		model: Schema.String,
		sessionId: Schema.String,
		idle: Schema.Boolean,
		confirmed: Schema.Boolean,
	}),
	handler: () =>
		Effect.gen(function* () {
			const ctx = yield* ExtensionContext;
			return {
				cwd: yield* ctx.cwd,
				model: (yield* ctx.model)?.id ?? "",
				sessionId: yield* ctx.sessionManager.getSessionId(),
				idle: yield* ctx.isIdle,
				// Without a mode's UI, Pi's dialogs answer at once: no confirmation.
				confirmed: yield* ctx.ui.confirm("Proceed?", "The test asks."),
			};
		}),
});

const relay = Tool.make("relay", {
	label: "Relay",
	description: "Runs the echo tool.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	handler: () =>
		Effect.gen(function* () {
			const tools = yield* ToolContext;
			const outcome = yield* tools.executeTool("echo", { text: "nested" });
			return outcome.result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		}),
});

describe("ExtensionContext", () => {
	it("is the context of the tool call: the session's directory, model, storage and UI as Effects", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { session, models, dir } = yield* openSession({
					extensions: [Extension.make("inspector", { tools: [inspect] })],
				});
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("Inspected."),
				]);
				yield* session.prompt("Inspect.");
				const [result] = texts(yield* session.messages, "toolResult");
				return { reported: JSON.parse(result ?? "{}"), dir, sessionId: yield* session.sessionId };
			}).pipe(Effect.provide(services)),
		);
		expect(seen.reported).toEqual({
			cwd: seen.dir,
			model: "faux-1",
			sessionId: seen.sessionId,
			idle: false,
			confirmed: false,
		});
	});
});

describe("ToolContext", () => {
	it("runs another tool from a tool, as the model would", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openSession({
					extensions: [Extension.make("relay", { tools: [echo, relay] })],
				});
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("relay", {})], { stopReason: "toolUse" }),
					fauxAssistantMessage("Relayed."),
				]);
				yield* session.prompt("Relay.");
				return texts(yield* session.messages, "toolResult");
			}).pipe(Effect.provide(services)),
		);
		expect(results).toEqual(["echo: nested"]);
	});
});

describe("CommandContext", () => {
	it("is the context of a command: it waits for the session to be idle", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const steps: string[] = [];
				const wait = Command.make("wait", {
					handler: () =>
						Effect.gen(function* () {
							const command = yield* CommandContext;
							yield* command.waitForIdle;
							steps.push(`idle: ${yield* (yield* ExtensionContext).isIdle}`);
						}),
				});
				const { session } = yield* openSession({ extensions: [Extension.make("wait", { commands: [wait] })] });
				yield* session.prompt("/wait");
				return steps;
			}).pipe(Effect.provide(services)),
		);
		expect(seen).toEqual(["idle: true"]);
	});
});
