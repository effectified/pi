// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the packages, this file the sources), and each test runs the example: in a
// temporary directory, on the scripted provider, against a scripted MCP server or the fixture agent.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxToolCall, runLive, runTest, ScriptedModels } from "@effectified/pi-ai/testing";
import { Env } from "@effectified/pi-env";
import type { McpClientService } from "@effectified/pi-mcp";
import { Context, Effect, Fiber, Latch, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	AgentSession,
	type AgentSessionRuntimeHandle,
	Builtin,
	Command,
	Extension,
	ExtensionContext,
	InteractiveMode,
	type InteractiveModeOptions,
	initTheme,
	isToolCallEventType,
	McpTools,
	ModelRuntime,
	ResourceLoader,
	RpcClient,
	type RpcClientOptions,
	SessionManager,
	SettingsManager,
	Tool,
} from "../src/index.ts";
import { next, openRuntime, sessionEvents, TestTerminal } from "./interactive.ts";
import { connected } from "./mcp-server.ts";
import { openSession as openTestSession, services, tempDir } from "./scripted.ts";

// README: writing an extension
// A service of your program. The extension's Effects reach it through the Layer you provide.
class Tickets extends Context.Service<Tickets, { readonly open: (title: string) => Effect.Effect<string> }>()(
	"app/Tickets",
) {}

const openTicket = Tool.make("open_ticket", {
	label: "Open ticket",
	description: "Opens a ticket and returns its id.",
	parameters: Schema.Struct({ title: Schema.String }),
	success: Schema.Struct({ id: Schema.String }),
	handler: ({ title }) =>
		Effect.map(
			Tickets.use((tickets) => tickets.open(title)),
			(id) => ({ id }),
		),
});

const where = Command.make("tickets", {
	description: "Says where the tickets of this project are kept.",
	handler: () =>
		Effect.gen(function* () {
			const ctx = yield* ExtensionContext;
			yield* ctx.ui.notify(`Tickets of ${yield* ctx.cwd} are in the tracker.`);
		}),
});

const ticketsExtension = Extension.make("tickets", {
	tools: [openTicket],
	commands: [where],
	on: {
		// The model opens tickets with the tool, never by hand in the shell.
		tool_call: (event) =>
			Effect.succeed(
				isToolCallEventType("bash", event) && event.input.command.includes(".tickets")
					? { block: true, reason: "Use open_ticket." }
					: undefined,
			),
	},
});

// README: an extension file (the README exports the factory as the file's default; here it is named)
const hello = Extension.make("hello", {
	commands: [
		Command.make("hello", { handler: () => Effect.flatMap(ExtensionContext, (ctx) => ctx.ui.notify("Hello!")) }),
	],
});

const helloFactory = Extension.factory(hello);

// README: a session
const openSession = (cwd: string) =>
	Effect.gen(function* () {
		const models = yield* ScriptedModels;
		const modelRuntime = yield* ModelRuntime.make({ authPath: `${cwd}/auth.json`, modelsPath: null });
		yield* modelRuntime.registerNativeProvider(models.provider);
		const settingsManager = yield* SettingsManager.inMemory();
		const resourceLoader = yield* ResourceLoader.make({
			cwd,
			agentDir: cwd,
			settingsManager,
			extensions: [ticketsExtension],
		});
		return yield* AgentSession.make({
			cwd,
			agentDir: cwd,
			model: models.model,
			modelRuntime,
			settingsManager,
			sessionManager: yield* SessionManager.inMemory(cwd),
			resourceLoader,
		});
	});

const program = (cwd: string) =>
	Effect.gen(function* () {
		const models = yield* ScriptedModels;
		yield* models.setResponses([
			fauxAssistantMessage([fauxToolCall("open_ticket", { title: "Flaky test" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Opened T-1."),
		]);
		const session = yield* openSession(cwd);
		// The events of one prompt; ending the Stream early aborts the run.
		const events = yield* Stream.runCollect(session.stream("Open a ticket for the flaky test."));
		yield* session.prompt("/tickets"); // the extension's command
		return { events: events.length, answer: yield* session.getLastAssistantText() };
	});

const live = Layer.mergeAll(ScriptedModels.layer(), Layer.succeed(Tickets, { open: () => Effect.succeed("T-1") }));

describe("the extension and the session of the README", () => {
	it("runs a prompt in which the model calls the extension's tool, then its command", async () => {
		const result = await runTest(
			Effect.flatMap(tempDir, (cwd) => Effect.scoped(program(cwd))).pipe(Effect.provide(live)),
		);
		expect(result.answer).toBe("Opened T-1.");
		expect(result.events).toBeGreaterThan(0);
	});

	it("blocks a shell command that touches the ticket store", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session, models } = yield* openTestSession({ extensions: [ticketsExtension] });
				yield* models.setResponses([
					fauxAssistantMessage([fauxToolCall("bash", { command: "cat .tickets/1" })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Blocked."),
				]);
				yield* session.prompt("Read ticket 1.");
				return (yield* session.messages).flatMap((message) =>
					message.role === "toolResult"
						? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
						: [],
				);
			}).pipe(Effect.provide(Layer.merge(services, Layer.succeed(Tickets, { open: () => Effect.succeed("T-2") })))),
		);
		expect(results).toEqual(["Use open_ticket."]);
	});

	it("gives an extension file Pi's factory, which a Pi host loads like any other", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const { session } = yield* openTestSession({ extensionFactories: [helloFactory] });
				yield* session.prompt("/hello");
				return session.pi.extensionRunner.getRegisteredCommands().map((command) => command.name);
			}).pipe(Effect.provide(services)),
		);
		expect(names).toEqual(["hello"]);
	});
});

// README: built-in tools
const rewrite = (cwd: string) =>
	Effect.gen(function* () {
		yield* Builtin.write(cwd).run({ path: "notes.md", content: "draft\n" });
		yield* Builtin.edit(cwd).run({ path: "notes.md", edits: [{ oldText: "draft", newText: "final" }] });
		const read = yield* Builtin.read(cwd).run({ path: "notes.md" });
		return read.content;
	});

// bash with its commands run in an execution environment of @effectified/pi-env (local, SSH, a daemon).
const bashIn = (cwd: string, env: Env.Env) => Builtin.bash(cwd, { operations: Builtin.bashOperations(env) });

describe("the built-in tools of the README", () => {
	it("write, edit and read a file", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const cwd = yield* tempDir;
				const content = yield* rewrite(cwd);
				return { content, file: readFileSync(join(cwd, "notes.md"), "utf8") };
			}),
		);
		expect(seen.file).toBe("final\n");
		expect(seen.content).toMatchObject([{ type: "text", text: expect.stringContaining("final") }]);
	});

	it("run bash in an environment of @effectified/pi-env", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const cwd = yield* tempDir;
				const env = yield* Env.fromPi(new NodeExecutionEnv({ cwd }));
				return yield* bashIn(cwd, env).run({ command: "echo in-env" });
			}),
		);
		expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining("in-env") }]);
	});
});

// README: MCP tools
const docsExtension = (client: McpClientService) =>
	Effect.map(McpTools.tools(client, { server: "docs" }), (tools) => Extension.make("docs", { tools }));

describe("the MCP tools of the README", () => {
	it("make an extension of an MCP server's tools", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const extension = yield* docsExtension(yield* connected);
				const { session } = yield* openTestSession({ extensions: [extension] });
				return yield* session.getActiveToolNames();
			}).pipe(Effect.provide(services)),
		);
		expect(names).toEqual(expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail"]));
	});
});

// README: interactive mode
// runtime: an AgentSessionRuntime (above). options.terminal: where it draws; none for this process's terminal.
const chat = (runtime: AgentSessionRuntimeHandle, options: InteractiveModeOptions = {}) =>
	Effect.scoped(
		Effect.gen(function* () {
			const session = yield* runtime.session;
			yield* initTheme(yield* session.settingsManager.getTheme());
			const mode = yield* InteractiveMode.make(runtime, options);
			// "quit" (Ctrl+D, /quit, an extension's shutdown) or "signal" (SIGTERM, SIGHUP).
			return yield* mode.run;
		}),
	);

describe("the interactive mode of the README", () => {
	it("chats on a virtual terminal until the user quits", async () => {
		const terminal = new TestTerminal(80, 30);
		const seen = await runTest(
			Effect.gen(function* () {
				// The mode binds the session's extensions once its TUI has started: then it takes input.
				const started = yield* Latch.make();
				const ready = Extension.make("ready", { on: { session_start: () => Effect.asVoid(Latch.open(started)) } });
				const { runtime, models } = yield* openRuntime([ready]);
				yield* models.setResponses([fauxAssistantMessage("Hello from the README.")]);
				const events = yield* sessionEvents(runtime);
				const running = yield* Effect.forkChild(chat(runtime, { terminal }), { startImmediately: true });
				yield* Latch.await(started);
				terminal.sendInput("Hi.");
				terminal.sendInput("\r");
				yield* next(events, "agent_settled");
				terminal.sendInput("\x04");
				const ending = yield* Fiber.join(running);
				return { ending, answer: yield* (yield* runtime.session).getLastAssistantText() };
			}).pipe(Effect.provide(services)),
		);
		expect(seen).toEqual({ ending: "quit", answer: "Hello from the README." });
	});
});

// README: modes and the RPC client
const ask = (options: RpcClientOptions) =>
	Effect.gen(function* () {
		const rpc = yield* RpcClient.make(options);
		const events = yield* rpc.promptAndWait("Hello.");
		return { settled: events.at(-1)?.type, answer: yield* rpc.getLastAssistantText() };
	});

/** Whether a `node` that runs TypeScript is on the PATH: Pi's RPC client starts the agent with `node`. */
const node = spawnSync("node", ["--version"], { encoding: "utf8" });
const NO_NODE = node.status !== 0 || Number(node.stdout.slice(1).split(".")[0]) < 23;

describe.skipIf(NO_NODE)("the RPC client of the README", () => {
	it("asks an agent process in RPC mode", async () => {
		const answer = await runLive(
			Effect.scoped(
				ask({
					cliPath: fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url)),
					env: { NODE_OPTIONS: "--conditions=source", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
				}),
			),
		);
		expect(answer).toEqual({ settled: "agent_settled", answer: "Answer 1." });
	});
});
