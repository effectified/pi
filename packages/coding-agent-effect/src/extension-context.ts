// What an extension's handlers, tools and commands see of the session they run in: Pi's extension contexts as services
// whose members are Effects. Each handler gets the context Pi passed to its call.

import type {
	CompactionResult,
	ExtensionUIDialogOptions,
	ExtensionCommandContext as PiCommandContext,
	ExtensionContext as PiContext,
	ProjectTrustContext as PiProjectTrustContext,
	ExtensionToolContext as PiToolContext,
	ExtensionUIContext as PiUi,
} from "@earendil-works/pi-coding-agent";
import type { ToolName } from "@effectified/pi-agent";
import { Context, Effect, Schema } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";
import { fromPiRegistry, type ModelRegistryHandle } from "./model-registry.ts";
import { SessionManager, type SessionManagerHandle, type SessionView, view } from "./session-manager.ts";

/** Pi's context of a session a command replaced the current one with; pi-coding-agent's root does not export it. */
type PiReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<PiCommandContext["newSession"]>[0]>["withSession"]>
>[0];

/** Pi's options of a dialog, without the signal: interrupting the fiber that waits for the dialog dismisses it. */
export type DialogOptions = Omit<ExtensionUIDialogOptions, "signal">;

/**
 * The user interface of the mode the session runs in: interactive mode's dialogs, notifications, status and widgets,
 * drawn in its TUI. In print and JSON mode the dialogs answer at once (no choice, `false`) and the rest does nothing,
 * as Pi's own. What hands Pi a component or a factory of one (custom components, footers, headers, editors,
 * autocomplete providers), the theme object and raw terminal input are not wrapped yet.
 */
export interface Ui {
	/** Asks the user to pick one of `options`; `undefined` when dismissed or timed out. */
	readonly select: (
		title: string,
		options: ReadonlyArray<string>,
		opts?: DialogOptions,
	) => Effect.Effect<string | undefined>;
	/** Asks the user to confirm; `false` when dismissed or timed out. */
	readonly confirm: (title: string, message: string, opts?: DialogOptions) => Effect.Effect<boolean>;
	/** Asks the user for a line of text; `undefined` when dismissed or timed out. */
	readonly input: (title: string, placeholder?: string, opts?: DialogOptions) => Effect.Effect<string | undefined>;
	/** Opens a multi-line editor; `undefined` when dismissed. */
	readonly editor: (title: string, prefill?: string) => Effect.Effect<string | undefined>;
	readonly notify: (message: string, type?: "info" | "warning" | "error") => Effect.Effect<void>;
	/** Sets (or, with `undefined`, clears) the text of `key` in the status bar. */
	readonly setStatus: (key: string, text: string | undefined) => Effect.Effect<void>;
	/** Sets the message shown while the agent works; none restores Pi's. */
	readonly setWorkingMessage: (message?: string) => Effect.Effect<void>;
	readonly setWorkingVisible: (visible: boolean) => Effect.Effect<void>;
	/** Sets the frames of the working indicator; none restores Pi's spinner. */
	readonly setWorkingIndicator: (options?: Parameters<PiUi["setWorkingIndicator"]>[0]) => Effect.Effect<void>;
	readonly setHiddenThinkingLabel: (label?: string) => Effect.Effect<void>;
	/** Shows `lines` above (or below) the editor under `key`; `undefined` removes them. */
	readonly setWidget: (
		key: string,
		lines: string[] | undefined,
		options?: Parameters<PiUi["setWidget"]>[2],
	) => Effect.Effect<void>;
	readonly setTitle: (title: string) => Effect.Effect<void>;
	readonly pasteToEditor: (text: string) => Effect.Effect<void>;
	readonly setEditorText: (text: string) => Effect.Effect<void>;
	readonly getEditorText: Effect.Effect<string>;
	readonly getToolsExpanded: Effect.Effect<boolean>;
	readonly setToolsExpanded: (expanded: boolean) => Effect.Effect<void>;
	/** The names and files of the themes the mode knows. */
	readonly getAllThemes: Effect.Effect<ReturnType<PiUi["getAllThemes"]>>;
	/** Switches to the theme named `name`. */
	readonly setTheme: (name: string) => Effect.Effect<ReturnType<PiUi["setTheme"]>>;
}

/** The context of an extension's call: the session, its model and its user interface. */
export interface ExtensionContextHandle {
	readonly ui: Ui;
	/** The mode the session runs in: `tui`, `rpc`, `json` or `print`. */
	readonly mode: Effect.Effect<PiContext["mode"]>;
	/** Whether the mode has dialogs (TUI and RPC). */
	readonly hasUI: Effect.Effect<boolean>;
	readonly cwd: Effect.Effect<string>;
	/** The session's entries, read-only. */
	readonly sessionManager: SessionView;
	readonly modelRegistry: ModelRegistryHandle;
	readonly model: Effect.Effect<PiContext["model"]>;
	readonly scopedModels: Effect.Effect<PiContext["scopedModels"]>;
	readonly thinkingLevel: Effect.Effect<PiContext["thinkingLevel"]>;
	readonly isIdle: Effect.Effect<boolean>;
	readonly isProjectTrusted: Effect.Effect<boolean>;
	/** Aborts what the agent is doing. */
	readonly abort: Effect.Effect<void>;
	readonly hasPendingMessages: Effect.Effect<boolean>;
	/** Shuts Pi down gracefully. */
	readonly shutdown: Effect.Effect<void>;
	readonly getContextUsage: Effect.Effect<ReturnType<PiContext["getContextUsage"]>>;
	/** Compacts the session and succeeds with the result when Pi reports it, or fails with Pi's error. */
	readonly compact: (customInstructions?: string) => Effect.Effect<CompactionResult, CodingAgentFailure>;
	readonly getSystemPrompt: Effect.Effect<string>;
}

/** The context of a tool call: the extension context, and the other tools it can run. */
export interface ToolContextHandle {
	/** The tools `executeTool` can run. */
	readonly tools: Effect.Effect<PiToolContext["tools"]>;
	/**
	 * Runs another tool as the model would, with its validation, hooks and permission checks. Never fails for the
	 * tool's own failure: an unknown tool, invalid arguments, a blocked call or a throw come back with `isError`.
	 * Interrupting the fiber aborts the nested call.
	 */
	readonly executeTool: (
		name: ToolName,
		args: unknown,
	) => Effect.Effect<Awaited<ReturnType<PiToolContext["executeTool"]>>, CodingAgentFailure>;
}

/** The result of a command's session change: `cancelled` when an extension refused it. */
export const Replacement = Schema.Struct({ cancelled: Schema.Boolean });

/** The result of a command's session change. */
export type Replacement = typeof Replacement.Type;

/**
 * What runs in the session a command replaced the current one with: its contexts are the services. A failure (`E`)
 * fails the replacement's Effect, as a throw rejects Pi's.
 */
export type InNewSession<E = unknown> = Effect.Effect<
	void,
	E,
	ExtensionContext | CommandContext | ReplacedSessionContext
>;

/** The context of a command: the session controls only a user's command may use. */
export interface CommandContextHandle {
	readonly getSystemPromptOptions: Effect.Effect<ReturnType<PiCommandContext["getSystemPromptOptions"]>>;
	readonly waitForIdle: Effect.Effect<void, CodingAgentFailure>;
	/** Starts a new session. `setup` writes its first entries; `withSession` runs in the new session. */
	readonly newSession: <E = never>(options?: {
		readonly parentSession?: string;
		readonly setup?: (sessionManager: SessionManagerHandle) => Effect.Effect<void>;
		readonly withSession?: InNewSession<E>;
	}) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Forks the session at the entry `entryId` into a new session file; `withSession` runs in the fork. */
	readonly fork: <E = never>(
		entryId: string,
		options?: { readonly position?: "before" | "at"; readonly withSession?: InNewSession<E> },
	) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Moves to another point of the session tree. */
	readonly navigateTree: (
		targetId: string,
		options?: Parameters<PiCommandContext["navigateTree"]>[1],
	) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Switches to the session stored in `sessionPath`; `withSession` runs in it. */
	readonly switchSession: <E = never>(
		sessionPath: string,
		options?: { readonly withSession?: InNewSession<E> },
	) => Effect.Effect<Replacement, CodingAgentFailure>;
	/** Reloads extensions, skills, prompts, themes and context files. */
	readonly reload: Effect.Effect<void, CodingAgentFailure>;
}

/**
 * What a command may still do in the session it replaced the current one with: the extension's own `ExtensionApi`
 * belongs to the replaced session, whose extensions Pi has unloaded.
 */
export interface ReplacedSessionContextHandle {
	/** Sends a custom message to the new session, as `ExtensionApi.sendMessage`. */
	readonly sendMessage: (
		...args: Parameters<PiReplacedSessionContext["sendMessage"]>
	) => Effect.Effect<void, CodingAgentFailure>;
	/** Sends a user message to the new session, as `ExtensionApi.sendUserMessage`. */
	readonly sendUserMessage: (
		...args: Parameters<PiReplacedSessionContext["sendUserMessage"]>
	) => Effect.Effect<void, CodingAgentFailure>;
}

/** The context of a `project_trust` handler: Pi asks it before a session exists, with the dialogs alone. */
export interface ProjectTrustContextHandle {
	readonly cwd: string;
	readonly mode: PiProjectTrustContext["mode"];
	readonly hasUI: boolean;
	readonly ui: Pick<Ui, "select" | "confirm" | "input" | "notify">;
}

/** The context of the call an extension's handler, tool or command is running in. */
export class ExtensionContext extends Context.Service<ExtensionContext, ExtensionContextHandle>()(
	"@effectified/pi-coding-agent/extension-context/ExtensionContext",
) {}

/** The context of the tool call a tool's handler is running in. */
export class ToolContext extends Context.Service<ToolContext, ToolContextHandle>()(
	"@effectified/pi-coding-agent/extension-context/ToolContext",
) {}

/** The context of the command a command's handler is running in. */
export class CommandContext extends Context.Service<CommandContext, CommandContextHandle>()(
	"@effectified/pi-coding-agent/extension-context/CommandContext",
) {}

/** The context of the session a command's `withSession` runs in. */
export class ReplacedSessionContext extends Context.Service<ReplacedSessionContext, ReplacedSessionContextHandle>()(
	"@effectified/pi-coding-agent/extension-context/ReplacedSessionContext",
) {}

/** The context of the `project_trust` question an extension's handler answers. */
export class ProjectTrustContext extends Context.Service<ProjectTrustContext, ProjectTrustContextHandle>()(
	"@effectified/pi-coding-agent/extension-context/ProjectTrustContext",
) {}

/** Pi's project trust context as a handle. */
export function fromPiProjectTrustContext(pi: PiProjectTrustContext): ProjectTrustContextHandle {
	return { cwd: pi.cwd, mode: pi.mode, hasUI: pi.hasUI, ui: dialogs(() => pi.ui) };
}

/** Pi's extension context as a handle. */
export function fromPiContext(pi: PiContext): ExtensionContextHandle {
	return {
		ui: ui(() => pi.ui),
		mode: Effect.sync(() => pi.mode),
		hasUI: Effect.sync(() => pi.hasUI),
		cwd: Effect.sync(() => pi.cwd),
		sessionManager: view(pi.sessionManager),
		modelRegistry: fromPiRegistry(pi.modelRegistry),
		model: Effect.sync(() => pi.model),
		scopedModels: Effect.sync(() => pi.scopedModels),
		thinkingLevel: Effect.sync(() => pi.thinkingLevel),
		isIdle: Effect.sync(() => pi.isIdle()),
		isProjectTrusted: Effect.sync(() => pi.isProjectTrusted()),
		abort: Effect.sync(() => pi.abort()),
		hasPendingMessages: Effect.sync(() => pi.hasPendingMessages()),
		shutdown: Effect.sync(() => pi.shutdown()),
		getContextUsage: Effect.sync(() => pi.getContextUsage()),
		compact: Effect.fn("ExtensionContext.compact")((customInstructions?: string) =>
			Effect.callback<CompactionResult, CodingAgentFailure>((resume) => {
				pi.compact({
					...(customInstructions === undefined ? {} : { customInstructions }),
					onComplete: (result) => resume(Effect.succeed(result)),
					onError: (error) => resume(Effect.fail(fromPi(error))),
				});
			}),
		),
		getSystemPrompt: Effect.sync(() => pi.getSystemPrompt()),
	};
}

/** Pi's tool context as a handle of its own members; the extension context is `fromPiContext` of the same object. */
export function fromPiToolContext(pi: PiToolContext): ToolContextHandle {
	return {
		tools: Effect.sync(() => pi.tools),
		executeTool: Effect.fn("ToolContext.executeTool")((name: ToolName, args: unknown) =>
			Effect.tryPromise({ try: (signal) => pi.executeTool(name, args, { signal }), catch: fromPi }),
		),
	};
}

/** Pi's command context as a handle of its own members. */
export function fromPiCommandContext(pi: PiCommandContext): CommandContextHandle {
	// Pi's asynchronous members, each a span named for it.
	const call = <A>(name: string, start: () => Promise<A>) =>
		Effect.tryPromise({ try: start, catch: fromPi }).pipe(Effect.withSpan(`CommandContext.${name}`));
	const inNew = <E>(withSession: InNewSession<E> | undefined) =>
		withSession === undefined ? {} : { withSession: inNewSession(withSession) };
	return {
		getSystemPromptOptions: Effect.sync(() => pi.getSystemPromptOptions()),
		waitForIdle: call("waitForIdle", () => pi.waitForIdle()),
		newSession: (options) => {
			const setup = options?.setup;
			return call("newSession", () =>
				pi.newSession({
					...(options?.parentSession === undefined ? {} : { parentSession: options.parentSession }),
					...(setup === undefined
						? {}
						: {
								setup: (sessionManager) => Effect.runPromise(setup(SessionManager.fromPi(sessionManager))),
							}),
					...inNew(options?.withSession),
				}),
			);
		},
		fork: (entryId, options) =>
			call("fork", () =>
				pi.fork(entryId, {
					...(options?.position === undefined ? {} : { position: options.position }),
					...inNew(options?.withSession),
				}),
			),
		navigateTree: (targetId, options) => call("navigateTree", () => pi.navigateTree(targetId, options)),
		switchSession: (sessionPath, options) =>
			call("switchSession", () => pi.switchSession(sessionPath, inNew(options?.withSession))),
		reload: call("reload", () => pi.reload()),
	};
}

/** `effect` with the extension context and the command context of Pi's `ctx`. */
export function inCommand<A, E, R>(
	effect: Effect.Effect<A, E, R>,
	ctx: PiCommandContext,
): Effect.Effect<A, E, Exclude<R, ExtensionContext | CommandContext>> {
	return Effect.provide(
		effect,
		Context.make(ExtensionContext, fromPiContext(ctx)).pipe(Context.add(CommandContext, fromPiCommandContext(ctx))),
	);
}

/** Pi's `withSession` callback that runs `withSession` in the session Pi replaced the current one with. */
export function inNewSession<E>(withSession: InNewSession<E>): (ctx: PiReplacedSessionContext) => Promise<void> {
	return (ctx) => runIn(withSession, ctx);
}

/** Runs `withSession` in the session Pi replaced the current one with, whose context is `ctx`. */
function runIn<E>(withSession: InNewSession<E>, ctx: PiReplacedSessionContext): Promise<void> {
	const replaced: ReplacedSessionContextHandle = {
		sendMessage: (message, options) =>
			Effect.tryPromise({ try: () => ctx.sendMessage(message, options), catch: fromPi }),
		sendUserMessage: (content, options) =>
			Effect.tryPromise({ try: () => ctx.sendUserMessage(content, options), catch: fromPi }),
	};
	return Effect.runPromise(inCommand(withSession, ctx).pipe(Effect.provideService(ReplacedSessionContext, replaced)));
}

/** Pi's user interface as `Ui`. `current` reads it at each call: Pi replaces it when a mode binds. */
function ui(current: () => PiUi): Ui {
	return {
		...dialogs(current),
		editor: (title, prefill) => Effect.promise(() => current().editor(title, prefill)),
		setStatus: (key, text) => Effect.sync(() => current().setStatus(key, text)),
		setWorkingMessage: (message) => Effect.sync(() => current().setWorkingMessage(message)),
		setWorkingVisible: (visible) => Effect.sync(() => current().setWorkingVisible(visible)),
		setWorkingIndicator: (options) => Effect.sync(() => current().setWorkingIndicator(options)),
		setHiddenThinkingLabel: (label) => Effect.sync(() => current().setHiddenThinkingLabel(label)),
		setWidget: (key, lines, options) => Effect.sync(() => current().setWidget(key, lines, options)),
		setTitle: (title) => Effect.sync(() => current().setTitle(title)),
		pasteToEditor: (text) => Effect.sync(() => current().pasteToEditor(text)),
		setEditorText: (text) => Effect.sync(() => current().setEditorText(text)),
		getEditorText: Effect.sync(() => current().getEditorText()),
		getToolsExpanded: Effect.sync(() => current().getToolsExpanded()),
		setToolsExpanded: (expanded) => Effect.sync(() => current().setToolsExpanded(expanded)),
		getAllThemes: Effect.sync(() => current().getAllThemes()),
		setTheme: (name) => Effect.sync(() => current().setTheme(name)),
	};
}

/** The dialogs and notifications of Pi's user interface: all a `project_trust` handler has. */
function dialogs(
	current: () => Pick<PiUi, "select" | "confirm" | "input" | "notify">,
): ProjectTrustContextHandle["ui"] {
	return {
		select: (title, options, opts) =>
			Effect.promise((signal) => current().select(title, [...options], { ...opts, signal })),
		confirm: (title, message, opts) =>
			Effect.promise((signal) => current().confirm(title, message, { ...opts, signal })),
		input: (title, placeholder, opts) =>
			Effect.promise((signal) => current().input(title, placeholder, { ...opts, signal })),
		notify: (message, type) => Effect.sync(() => current().notify(message, type)),
	};
}
