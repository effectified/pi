// A running pi-tui renderer as a scoped service: started when its scope opens, stopped when it closes, driven by Effects.

import {
	type Component,
	type OverlayOptions,
	ProcessTerminal,
	type Terminal,
	type TerminalColors,
	type TUI,
	TuiAltScreen,
	type TuiAltScreenOptions,
	TuiMainScreen,
	type TuiStopOptions,
} from "@earendil-works/pi-tui";
import { Duration, Effect, Exit, FiberSet, Layer, Match, type Scope } from "effect";
import { Tui } from "./tui-service.ts";

// The TUI's input, terminal color scheme and suspend signal as Streams, and its terminal's own state, under this
// module's name.
export { colorSchemes, input, presses, suspends } from "./tui-input.ts";
export { Tui } from "./tui-service.ts";
export { type DrainOptions, drainInput, progress, setProgramStatus, setTitle } from "./tui-terminal.ts";

/** How a TUI starts and stops: pi-tui's constructor arguments and the options `stop` gets when the scope closes. */
export interface Options {
	/** The terminal it draws on. Default: a `ProcessTerminal` on this process's stdin and stdout. */
	readonly terminal?: Terminal;
	/** Show the terminal's own cursor where the focused component puts its cursor marker (pi-tui's default: no). */
	readonly showHardwareCursor?: ConstructorParameters<typeof TuiMainScreen>[1];
	/** Where pi-tui writes its debug and crash logs. Default: none, and crash dumps go to the OS temp directory. */
	readonly logDirectory?: ConstructorParameters<typeof TuiMainScreen>[2];
	/** What pi-tui's `stop` gets when the scope closes, such as `preserveScreen` for a TUI that takes over. */
	readonly stop?: TuiStopOptions;
}

/**
 * The options of a fullscreen TUI: those of `Options`, and pi-tui's alternate-screen options, whose callbacks are
 * Effects here. They run in the TUI's scope with its services `R`, and are interrupted when it closes.
 */
export interface FullscreenOptions<R = never> extends Options {
	readonly altScreen?: Omit<TuiAltScreenOptions, "openUrl" | "onRightClickPaste" | "copySelection"> & {
		/** Opens an OSC 8 hyperlink the user clicked. Without it, a click on a link is a click on text. */
		readonly openUrl?: (url: string) => Effect.Effect<void, never, R>;
		/** Pastes the clipboard on a right click (pi-tui does this on Windows only). */
		readonly onRightClickPaste?: Effect.Effect<void, never, R>;
		/**
		 * Copies selected text: `true` when copied, or the message to show when not (`false` for pi-tui's own).
		 * Without it, pi-tui copies with an OSC 52 write. An interrupted copy counts as not copied.
		 */
		readonly copySelection?: (text: string) => Effect.Effect<boolean | string, never, R>;
	};
}

/** The options of `layer`: a TUI in the terminal's main screen and scrollback, or a fullscreen one. */
export type LayerOptions<R = never> =
	| ({ readonly mode: "regular" } & Options)
	| ({ readonly mode: "fullscreen" } & FullscreenOptions<R>);

/** The `Tui` service: a TUI started by `regular` or `fullscreen` (`mode`), stopped when the Layer's scope closes. */
export function layer<R = never>(options: LayerOptions<R>): Layer.Layer<Tui, never, R> {
	return Match.value(options).pipe(
		Match.discriminatorsExhaustive("mode")({
			regular: (regularOptions) => Layer.effect(Tui, regular(regularOptions)),
			fullscreen: (fullscreenOptions) => Layer.effect(Tui, fullscreen(fullscreenOptions)),
		}),
	);
}

/**
 * A TUI that renders into the terminal's main screen and scrollback (pi-tui's `TuiMainScreen`, mode `"regular"`),
 * started now and stopped when the scope closes, which hands the terminal back as it was.
 */
export const regular = Effect.fn("Tui.regular")((options: Options = {}) =>
	started(
		() =>
			new TuiMainScreen(options.terminal ?? new ProcessTerminal(), options.showHardwareCursor, options.logDirectory),
		options.stop,
	),
);

/**
 * A fullscreen TUI on the terminal's alternate screen with a scrollable viewport (pi-tui's `TuiAltScreen`, mode
 * `"fullscreen"`), started now and stopped when the scope closes.
 */
export const fullscreen: <R = never>(
	options?: FullscreenOptions<R>,
) => Effect.Effect<TuiAltScreen, never, Scope.Scope | R> = Effect.fn("Tui.fullscreen")(function* <R>(
	options: FullscreenOptions<R> = {},
) {
	const { openUrl, onRightClickPaste, copySelection, ...altScreen } = options.altScreen ?? {};
	// The callbacks run as fibers of this scope, made before the TUI starts: closing it interrupts them after the stop.
	const fork = yield* FiberSet.makeRuntime<R>();
	const services = yield* Effect.context<R>();
	const piOptions: TuiAltScreenOptions = {
		...altScreen,
		...(openUrl === undefined ? {} : { openUrl: (url) => void fork(openUrl(url)) }),
		...(onRightClickPaste === undefined ? {} : { onRightClickPaste: () => void fork(onRightClickPaste) }),
		...(copySelection === undefined
			? {}
			: {
					// pi-tui awaits this without a catch: an interrupted copy resolves as not copied instead of rejecting.
					copySelection: (text) =>
						Effect.runPromiseWith(services)(
							Effect.map(Effect.exit(copySelection(text)), (exit) =>
								Exit.isSuccess(exit) ? exit.value : false,
							),
						),
				}),
	};
	return yield* started(
		() =>
			new TuiAltScreen(
				options.terminal ?? new ProcessTerminal(),
				options.showHardwareCursor,
				options.logDirectory,
				piOptions,
			),
		options.stop,
	);
});

/** `make`'s TUI started, and stopped with `stop` when the scope closes. */
function started<T extends TUI>(make: () => T, stop: TuiStopOptions | undefined): Effect.Effect<T, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => {
			const tui = make();
			tui.start();
			return tui;
		}),
		(tui) => Effect.sync(() => tui.stop(stop)),
	);
}

/**
 * Renders a frame now (pi-tui's `renderNow`); `force` redraws the whole screen instead of what changed. Untraced: a
 * program renders per frame.
 */
export const render = Effect.fnUntraced(function* (force?: boolean) {
	yield* Tui.useSync((tui) => tui.renderNow(force));
});

/**
 * Asks for a frame (pi-tui's `requestRender`): pi-tui draws it on the next tick, at most one per 16 ms, after any
 * other changes made meanwhile. `force` redraws the whole screen. The way to show a change made to a component.
 * Untraced: a program asks for one per change.
 */
export const requestRender = Effect.fnUntraced(function* (force?: boolean) {
	yield* Tui.useSync((tui) => tui.requestRender(force));
});

/** Gives keyboard focus to `component`, or to nothing (pi-tui's `setFocus`). */
export const setFocus = Effect.fn("Tui.setFocus")(function* (component: Component | null) {
	yield* Tui.useSync((tui) => tui.setFocus(component));
});

/**
 * Shows `component` above the content (pi-tui's `showOverlay`), focused unless `options.nonCapturing`, and hides it
 * for good when the scope closes, giving focus back as pi-tui does. The handle hides or shows it meanwhile.
 */
export const showOverlay = Effect.fn("Tui.showOverlay")((component: Component, options?: OverlayOptions) =>
	Effect.acquireRelease(
		Tui.useSync((tui) => tui.showOverlay(component, options)),
		(handle) => Effect.sync(() => handle.hide()),
	),
);

/**
 * Asks the terminal for its theme colors (pi-tui's `queryTerminalColors`): the default foreground and background and
 * the 16 palette colors. Completes when the terminal answered, or after `timeout` with what it answered so far; colors
 * it did not report are `undefined`. pi-tui's own timer measures the timeout, and it ignores replies that come later.
 */
export const queryColors: (timeout: Duration.Input) => Effect.Effect<TerminalColors, never, Tui> = Effect.fn(
	"Tui.queryColors",
)((timeout: Duration.Input) =>
	Tui.use((tui) => Effect.promise(() => tui.queryTerminalColors({ timeoutMs: Duration.toMillis(timeout) }))),
);

/**
 * Copies the fullscreen TUI's text selection (pi-tui's `copyActiveSelectionToClipboard`) with its `copySelection`, or
 * with an OSC 52 write: `true` when it copied, `false` when nothing is selected or the copy failed.
 */
export const copyActiveSelection = Effect.fn("Tui.copyActiveSelection")((screen: TuiAltScreen) =>
	Effect.promise(() => screen.copyActiveSelectionToClipboard()),
);
