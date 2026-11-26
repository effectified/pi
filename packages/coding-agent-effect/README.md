# @effectified/pi-coding-agent

Pi's coding agent ([`@earendil-works/pi-coding-agent`](../coding-agent)) in Effect terms, for `effect` 4.1:

- Pi extensions written as Effect programs: `Extension.make` with tools, commands, shortcuts, flags and event
  handlers that are Effects using your services. It becomes Pi's own inline extension (or extension factory), so a Pi
  host loads it like any other. The context of each call (`ExtensionContext`, `ToolContext`, `CommandContext`) and
  the extension's API (`ExtensionApi`) are services inside the handlers, with Effect members.
- Sessions as scoped services: a prompt is an Effect, the session's events are a Stream, compaction and summaries are
  Effects, and interrupting a fiber aborts what Pi lets it (the run, a compaction, a branch summary, a shell command).
  The session runtime, the session storage, the settings and the resources are services too.
- The built-in tools (read, write, edit, bash, grep, find, ls, PowerShell) from Pi's definition factories, each a
  tool of a session or an extension and runnable as an Effect; bash can run in an environment of
  [`@effectified/pi-env`](../env-effect/README.md).
- An MCP server's tools as Pi tools, through [`@effectified/pi-mcp`](../mcp-effect/README.md), as Pi's own MCP
  extension makes them.
- The model runtime, model registry, package manager and project trust store as services whose operations are
  Effects; providers of [`@effectified/pi-ai`](../ai-effect/README.md) register on the runtime.
- Print mode and RPC mode as Effects, and the RPC client as a scoped resource whose commands are Effects and whose
  events are a Stream.
- Interactive mode, Pi's terminal UI, as a scoped service on [`@effectified/pi-tui`](../tui-effect/README.md): it runs
  until the user quits, and its scope hands the terminal back. Its components are pi-tui components as they are, or
  scoped Effects whose callbacks are a Stream; setting the theme is an Effect.
- pi-coding-agent's errors as one union of tagged errors, `CodingAgentFailure`.

It adds no behaviour of its own: what pi-coding-agent does is what happens. Built for pi-coding-agent 1.6.1.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.2.0
npm install --allow-remote=all $R/effectified-pi-coding-agent-0.2.0.tgz $R/effectified-pi-agent-0.2.0.tgz $R/effectified-pi-ai-0.2.0.tgz $R/effectified-pi-mcp-0.2.0.tgz $R/effectified-pi-env-0.2.0.tgz $R/effectified-pi-schema-0.2.0.tgz $R/effectified-pi-tui-0.2.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Writing an extension

An extension is a value. Its tool's handler gets the decoded arguments and runs with your services; its command
reads the context of the command; its handler of `tool_call` blocks a call. Everything is an Effect.

```ts
import { Context, Effect, Schema } from "effect";
import { Command, Extension, ExtensionContext, isToolCallEventType, Tool } from "@effectified/pi-coding-agent";

// A service of your program. The extension's Effects reach it through the Layer you provide.
class Tickets extends Context.Service<Tickets, { readonly open: (title: string) => Effect.Effect<string> }>()(
	"app/Tickets",
) {}

const openTicket = Tool.make("open_ticket", {
	label: "Open ticket",
	description: "Opens a ticket and returns its id.",
	parameters: Schema.Struct({ title: Schema.String }),
	success: Schema.Struct({ id: Schema.String }),
	handler: ({ title }) => Effect.map(Tickets.use((tickets) => tickets.open(title)), (id) => ({ id })),
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
```

`Extension.make` infers what the extension needs (`Tickets` here). `ticketsExtension.inline` is an Effect of Pi's
inline extension: run it with those services, or give the extension to `ResourceLoader.make` (below), which does.
Inside handlers, `ExtensionApi` is the API of this load of the extension: `sendMessage`, `appendEntry`, `exec`,
`setActiveTools`, `registerTool`, `registerCommand`, `emit` and `events` (a Stream of a channel), and the rest of
Pi's `ExtensionAPI` under its names. A tool's handler also has `ToolContext` (`executeTool` runs another tool as the
model would); a command's has `CommandContext` (`newSession`, `fork`, `navigateTree`, `switchSession`, `reload`). A
handler's failure is reported by Pi as an extension error, as a throw is.

An extension file that Pi loads from a path exports Pi's factory. Its Effects need no service of yours:

```ts
import { Effect } from "effect";
import { Command, Extension, ExtensionContext } from "@effectified/pi-coding-agent";

const hello = Extension.make("hello", {
	commands: [
		Command.make("hello", { handler: () => Effect.flatMap(ExtensionContext, (ctx) => ctx.ui.notify("Hello!")) }),
	],
});

export default Extension.factory(hello);
```

## A session

A session is a scoped resource over a model runtime, settings, session storage and resources, each a handle of this
package. Here the model is `@effectified/pi-ai`'s scripted provider: no network, no key.

```ts
import { Effect, Layer, Stream } from "effect";
import { fauxAssistantMessage, fauxToolCall, ScriptedModels } from "@effectified/pi-ai/testing";
import {
	AgentSession,
	ModelRuntime,
	ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@effectified/pi-coding-agent";

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
```

`Effect.scoped(program(cwd)).pipe(Effect.provide(live))` answers `Opened T-1.`. Closing the scope aborts what the
session runs, waits until it is idle and disposes it. Every member of Pi's `AgentSession` is on the handle under its
name: its fields and getters (`messages`, `model`, `isStreaming`, ...) as Effects that read them, its methods as
Effects; `subscribe` is a Stream of every event until its scope closes. `prompt`, `compact`, `navigateTree` and
`executeBash` abort Pi's work when interrupted. `AgentSession.layer` builds the session from the `ModelRuntime`,
`SettingsManager`, `SessionManager` and `ResourceLoader` services instead. `AgentSessionRuntime.make` holds the
session of a CLI-like host, replaced by `newSession`, `switchSession`, `fork` and `importFromJsonl`.

`Compaction.compact`, `Compaction.generateSummary` and `Compaction.generateBranchSummary` request their summaries
through `@effectified/pi-agent`'s `StreamFn` service.

## Built-in tools

Each built-in tool of Pi is made for a working directory, from Pi's own factory. It is a tool for a session's
`customTools` or an extension's `tools`, and runs on its own as an Effect.

```ts
import { Effect } from "effect";
import { Builtin } from "@effectified/pi-coding-agent";
import type { Env } from "@effectified/pi-env";

const rewrite = (cwd: string) =>
	Effect.gen(function* () {
		yield* Builtin.write(cwd).run({ path: "notes.md", content: "draft\n" });
		yield* Builtin.edit(cwd).run({ path: "notes.md", edits: [{ oldText: "draft", newText: "final" }] });
		const read = yield* Builtin.read(cwd).run({ path: "notes.md" });
		return read.content;
	});

// bash with its commands run in an execution environment of @effectified/pi-env (local, SSH, a daemon).
const bashIn = (cwd: string, env: Env.Env) => Builtin.bash(cwd, { operations: Builtin.bashOperations(env) });
```

`Builtin.coding` and `Builtin.readOnly` are Pi's two sets. `Builtin.withFileMutationQueue(path, effect)` runs
`effect` in Pi's queue of mutations of that file, after those queued before it by Pi's own tools.

## MCP tools

The tools an MCP server lists, as Pi's MCP extension makes them: named `mcp__<server>__<tool>`, grouped in the
server's namespace, results converted and limited as Pi does.

```ts
import { Effect } from "effect";
import { Extension, McpTools } from "@effectified/pi-coding-agent";
import type { McpClientService } from "@effectified/pi-mcp";

const docsExtension = (client: McpClientService) =>
	Effect.map(McpTools.tools(client, { server: "docs" }), (tools) => Extension.make("docs", { tools }));
```

The client is `@effectified/pi-mcp`'s `McpClient`, connected for as long as its scope lives. A call's progress
notifications are the tool's updates; interrupting it cancels the request on the server.

## Modes and the RPC client

`Modes.print(runtime, options)` runs one prompt and writes its answer to stdout; `Modes.rpc(runtime)` serves JSON
commands on stdin; `Modes.main(args)` is Pi's CLI. `RpcClient.make` starts an agent process in RPC mode for the
scope:

```ts
import { Effect } from "effect";
import { RpcClient, type RpcClientOptions } from "@effectified/pi-coding-agent";

const ask = (options: RpcClientOptions) =>
	Effect.gen(function* () {
		const rpc = yield* RpcClient.make(options);
		const events = yield* rpc.promptAndWait("Hello.");
		return { settled: events.at(-1)?.type, answer: yield* rpc.getLastAssistantText() };
	});
```

Every command of Pi's `RpcClient` is an Effect under its name; `events` is a Stream of the process's events.
`waitForIdle` and `collectEvents` have no deadline of their own: add one with `Effect.timeout`, on `Clock`.

## Interactive mode

Pi's terminal UI over a session runtime: the chat, the editor, the footer, the slash commands, and the dialogs of
extensions. `InteractiveMode.make` starts it for the scope; `run` sends what the user types until they quit.

```ts
import { Effect } from "effect";
import {
	type AgentSessionRuntimeHandle,
	InteractiveMode,
	type InteractiveModeOptions,
	initTheme,
} from "@effectified/pi-coding-agent";

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
```

- **`InteractiveMode.make(runtime, options)`** starts Pi's mode: its TUI takes the terminal, the session's extensions
  are bound to it, and the chat shows the session. Pi makes its own TUI on `options.terminal`, since it replaces it
  when the user switches between regular and fullscreen; `mode.tui` is that TUI. Closing the scope stops the mode as
  Pi's quit does and hands the terminal back; the runtime's own scope then ends the session. Where Pi's quit ends the
  process, `run` ends instead, with `"quit"` or `"signal"`.
- **`InteractiveMode.layer(options)`** builds it over the program's `AgentSessionRuntime`, and gives its TUI as
  `@effectified/pi-tui`'s `Tui` service: `Tui.showOverlay`, `Tui.presses` and `loader` work on the mode's own TUI.
- **`initTheme(name)`** sets the theme of the process, which the mode, its components and the theme helpers draw
  with. Run it first, with the settings' theme, as Pi's CLI does.
- An extension's `ExtensionContext.ui` is the mode's: `select`, `confirm`, `input` and `editor` show Pi's dialogs and
  wait for the user; `notify`, `setStatus`, `setWidget` and `setTitle` draw in the TUI.

The components of interactive mode, for a program that composes its own screen:

- The views of messages (`AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, ...),
  `DynamicBorder`, `FooterComponent` and `CustomEditor` are pi-tui components as they are. Their callback properties
  (`onSubmit`, `onEscape`, ...) are Streams through `@effectified/pi-tui`'s `events`.
- The selectors (`themeSelector`, `thinkingSelector`, `modelSelector`, `sessionSelector`, `treeSelector`,
  `settingsSelector`, ...) and the dialogs (`extensionInput`, `extensionSelector`, `extensionEditor`, `loginDialog`)
  take their callbacks in Pi's constructors. Here each is a scoped Effect that gives `{ component, events }`: the
  component, and each call of its callbacks as `{ kind, args }` (`{ kind: "select", args: ["dark"] }`), until the
  scope closes. Those that need the running TUI take it from the `Tui` service.
- `armin`, `borderedLoader` and `bashExecution` animate on a timer from the moment they are made: scoped Effects for
  the `Tui` service, whose timer stops when the scope closes.
- `Theme` and the helpers a component's `render` calls (`keyHint`, `keyText`, `rawKeyHint`, `highlightCode`,
  `renderDiff`, `getMarkdownTheme`, `getSelectListTheme`, `getSettingsListTheme`) are Pi's. They read the theme of the
  process and its keybindings at the call, as pi-tui's components read their keybindings.

## Errors

Every call into Pi fails with `CodingAgentFailure`: `CredentialSynchronizationError` (a credential change stored but
not synchronized), `SessionImportFileNotFound`, or `CodingAgentError` with Pi's message and its error as the cause.
Building a tool fails with `@effectified/pi-schema`'s `SchemaConversionError` when its schema has no JSON Schema.

## Not wrapped yet

- The parts of the extension API that hand Pi a component or a factory Pi calls while it draws: message, entry and
  tool renderers, and on `ExtensionContext.ui` custom components, headers, footers, editors, autocomplete providers,
  the theme object and raw terminal input.
- Interactive mode's timers (the render throttle, spinners, countdowns, the 100 ms wait for the terminal's colors)
  are Pi's and pi-tui's, not `Clock`. Where Pi's quit prints how to resume the session and ends the process, `run`
  ends and prints nothing.
- OAuth login on the model runtime (`login`), as in `@effectified/pi-ai`.
- The model runtime's own requests (`stream`, `complete`, image generation, classification): a session makes them;
  `@effectified/pi-ai` makes requests on a `Models` of its own.
- The progress of listing sessions; a package install reports its progress on `PackageManager`'s `progress` Stream,
  its command output on Pi's console.

## License

MIT
