import { ToolName } from "@effectified/pi-agent";
import { fauxAssistantMessage, fauxToolCall, runTest } from "@effectified/pi-ai/testing";
import { Deferred, Effect, Fiber, Latch, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Command, CommandContext, Extension, ExtensionContext, Tool, ToolContext } from "../src/index.ts";
import { openMode, openRuntime, screen, TestTerminal } from "./interactive.ts";
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
			const outcome = yield* tools.executeTool(ToolName.make("echo"), { text: "nested" });
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

describe("ExtensionContext.ui in interactive mode", () => {
	it("asks the user through Pi's TUI and shows what the extension sets", async () => {
		const terminal = new TestTerminal(80, 30);
		const seen = await runTest(
			Effect.gen(function* () {
				const asked = yield* Latch.make();
				const done = yield* Deferred.make<string | undefined>();
				const ask = Command.make("ask", {
					handler: () =>
						Effect.gen(function* () {
							const { ui, mode, hasUI } = yield* ExtensionContext;
							// Started at once, so the dialog is on screen when the latch opens.
							const answer = yield* Effect.forkChild(ui.select("Pick a color", ["red", "green"]), {
								startImmediately: true,
							});
							yield* Latch.open(asked);
							const color = yield* Fiber.join(answer);
							yield* ui.notify(`picked ${color} in ${yield* mode} (dialogs: ${yield* hasUI})`);
							yield* ui.setStatus("color", `color: ${color}`);
							yield* ui.setWidget("palette", ["a widget of the extension"]);
							yield* Deferred.succeed(done, color);
						}),
				});
				const { runtime } = yield* openRuntime([Extension.make("ask", { commands: [ask] })]);
				const mode = yield* openMode(runtime, terminal);
				yield* Effect.forkChild(mode.run, { startImmediately: true });
				terminal.sendInput("/ask");
				terminal.sendInput("\r");
				yield* Latch.await(asked);
				const dialog = yield* screen(mode, terminal);
				// Down to "green", then confirm.
				terminal.sendInput("\x1b[B");
				terminal.sendInput("\r");
				const picked = yield* Deferred.await(done);
				return { dialog: dialog.join("\n"), picked, after: (yield* screen(mode, terminal)).join("\n") };
			}).pipe(Effect.provide(services)),
		);
		expect(seen.dialog).toContain("Pick a color");
		expect(seen.dialog).toContain("green");
		expect(seen.picked).toBe("green");
		expect(seen.after).toContain("picked green in tui (dialogs: true)");
		expect(seen.after).toContain("color: green");
		expect(seen.after).toContain("a widget of the extension");
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
