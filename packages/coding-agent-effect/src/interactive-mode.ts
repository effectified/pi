// pi-coding-agent's interactive mode in Effect: Pi's terminal UI over a session runtime as a scoped service, started
// when its scope opens, run as an Effect that ends when the user quits, and stopped when the scope closes.

import { type InteractiveModeOptions, InteractiveMode as PiInteractiveMode } from "@earendil-works/pi-coding-agent";
import { type TUI, Tui } from "@effectified/pi-tui";
import { Context, Deferred, Effect, Layer, type Scope } from "effect";
import { AgentSessionRuntime, type AgentSessionRuntimeHandle } from "./agent-session-runtime.ts";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/**
 * Why interactive mode ended: the user quit (Ctrl+D on an empty editor, Ctrl+C twice, `/quit`, the session selector's
 * exit, an extension's `shutdown`), or the process got SIGTERM or SIGHUP.
 */
export type Ending = "quit" | "signal";

/**
 * Pi's options of interactive mode: the first messages to send, the startup notices, `tuiMode` (`"regular"` or
 * `"fullscreen"`; default: the setting) and `terminal`, the terminal it draws on (default: this process's stdin and
 * stdout).
 */
export type Options = InteractiveModeOptions;

/** Interactive mode, started: Pi's members as Effects, and the run until the user quits. */
export interface InteractiveModeHandle {
	/** Pi's interactive mode, for what takes one as it is. */
	readonly pi: PiInteractiveMode;
	/**
	 * The TUI the mode draws on: Pi's reference to it, which follows the mode when the user switches between regular
	 * and fullscreen. It is the `Tui` service of `InteractiveMode.layer`.
	 */
	readonly tui: TUI;
	/**
	 * Runs Pi's interactive loop: shows the startup notices, sends the options' first messages, then sends what the user
	 * submits, until the user quits; succeeds with why it ended. It ends at once if the user quit before. Pi's loop
	 * cannot be stopped from outside: interrupting it stops waiting, and the mode takes input until its scope closes.
	 * Run it once.
	 */
	readonly run: Effect.Effect<Ending, CodingAgentFailure>;
	/** The next text the user submits in the editor while `run` is not running. */
	readonly getUserInput: Effect.Effect<string>;
	/** Shows the session's messages in the chat. */
	readonly renderInitialMessages: Effect.Effect<void>;
	/** Empties the editor. */
	readonly clearEditor: Effect.Effect<void>;
	/** Shows an error in the chat. */
	readonly showError: (message: string) => Effect.Effect<void>;
	/** Shows a warning in the chat. */
	readonly showWarning: (message: string) => Effect.Effect<void>;
	/** Shows that a newer Pi was released. */
	readonly showNewVersionNotification: (
		release: Parameters<PiInteractiveMode["showNewVersionNotification"]>[0],
	) => Effect.Effect<void>;
	/** Shows that updates of these packages are available. */
	readonly showPackageUpdateNotification: (packages: ReadonlyArray<string>) => Effect.Effect<void>;
}

/** The interactive mode of the program. */
export class InteractiveMode extends Context.Service<InteractiveMode, InteractiveModeHandle>()(
	"@effectified/pi-coding-agent/InteractiveMode",
) {
	/**
	 * Interactive mode over the program's `AgentSessionRuntime`, for the Layer's scope, and its TUI as pi-tui's `Tui`
	 * service, so `@effectified/pi-tui`'s functions (overlays, key presses, input) drive the mode's own TUI.
	 */
	static layer(
		options: Options = {},
	): Layer.Layer<InteractiveMode | Tui.Tui, CodingAgentFailure, AgentSessionRuntime> {
		return Layer.effectContext(
			Effect.gen(function* () {
				const mode = yield* InteractiveMode.make(yield* AgentSessionRuntime, options);
				return Context.make(InteractiveMode, mode).pipe(Context.add(Tui.Tui, mode.tui));
			}),
		);
	}

	/**
	 * Pi's interactive mode over `runtime`, started: its TUI takes the terminal, the session's extensions are bound to
	 * it (`session_start`), and the chat shows the session. Pi makes its own TUI on `options.terminal`, because it
	 * replaces it when the user switches between regular and fullscreen. Closing the scope stops the mode as Pi's quit
	 * does (reads the terminal's pending input, stops the TUI and hands the terminal back); the runtime stays the
	 * caller's, so the runtime's scope ends the session. Pi sets the process's keybindings, theme and terminal
	 * capabilities from the settings, and leaves them set.
	 */
	static make(
		runtime: AgentSessionRuntimeHandle,
		options: Options = {},
	): Effect.Effect<InteractiveModeHandle, CodingAgentFailure, Scope.Scope> {
		return Effect.gen(function* () {
			const ended = yield* Deferred.make<Ending>();
			const pi = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const made = new PiInteractiveMode(runtime.pi, options);
					endInsteadOfExit(made, ended);
					return made;
				}),
				(made) => stopped(made),
			);
			yield* Effect.tryPromise({ try: () => pi.init(), catch: fromPi });
			return handle(pi, ended);
		});
	}
}

/** Pi's quit and signal handling as `ended`, instead of ending the process. */
function endInsteadOfExit(pi: PiInteractiveMode, ended: Deferred.Deferred<Ending>): void {
	// Every way out of Pi's interactive mode (the quit keys, `/quit`, an extension's `shutdown`, SIGTERM and SIGHUP)
	// calls its private `shutdown`, which disposes the runtime and ends the process. Pi offers no other hook, so this
	// instance's own `shutdown` takes its place: the run ends, and the scopes of the mode and the runtime clean up.
	const quitting: { shutdown: (options?: { fromSignal?: boolean }) => Promise<void> } =
		pi as unknown as typeof quitting;
	quitting.shutdown = (options) => {
		Deferred.doneUnsafe(ended, Effect.succeed(options?.fromSignal === true ? "signal" : "quit"));
		return Promise.resolve();
	};
}

/** Stops `pi` as its quit does before it disposes the runtime: drains the terminal's input, then stops the mode. */
function stopped(pi: PiInteractiveMode): Effect.Effect<void> {
	const tui = currentTui(pi);
	return Effect.promise(() => tui.terminal.drainInput(1000)).pipe(Effect.ensuring(Effect.sync(() => pi.stop())));
}

/** Pi's reference to the TUI the mode draws on, kept in its private `ui` field. */
function currentTui(pi: PiInteractiveMode): TUI {
	// Pi does not expose its TUI; its `ui` field is the reference its components hold, which follows a renderer switch.
	return (pi as unknown as { readonly ui: TUI }).ui;
}

/** Pi's interactive mode as a handle; `ended` completes when the user quits. */
function handle(pi: PiInteractiveMode, ended: Deferred.Deferred<Ending>): InteractiveModeHandle {
	return {
		pi,
		tui: currentTui(pi),
		run: Effect.raceFirst(
			Deferred.await(ended),
			Effect.flatMap(
				Effect.tryPromise({ try: () => pi.run(), catch: fromPi }),
				// Pi's loop never ends on its own: it waits for the user's next text.
				() => Effect.never,
			),
		),
		getUserInput: Effect.promise(() => pi.getUserInput()),
		renderInitialMessages: Effect.sync(() => pi.renderInitialMessages()),
		clearEditor: Effect.sync(() => pi.clearEditor()),
		showError: (message) => Effect.sync(() => pi.showError(message)),
		showWarning: (message) => Effect.sync(() => pi.showWarning(message)),
		showNewVersionNotification: (release) => Effect.sync(() => pi.showNewVersionNotification(release)),
		showPackageUpdateNotification: (packages) => Effect.sync(() => pi.showPackageUpdateNotification([...packages])),
	};
}
