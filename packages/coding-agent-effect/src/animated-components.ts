// Interactive mode's components that animate on a timer from the moment they are made: scoped, so the timer stops when
// the scope closes.

import { ArminComponent, BashExecutionComponent, BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Tui } from "@effectified/pi-tui";
import { Effect, type Scope } from "effect";

/** Pi's Armin, drawing itself in with one of its effects for the running TUI until the scope closes. */
export const armin: Effect.Effect<ArminComponent, never, Tui.Tui | Scope.Scope> = Effect.acquireRelease(
	Tui.Tui.useSync((tui) => new ArminComponent(tui)),
	(made) => Effect.sync(() => made.dispose()),
);

type LoaderArgs = ConstructorParameters<typeof BorderedLoader>;

/**
 * Pi's spinner with a message between two borders, for the running TUI, animating until the scope closes. With
 * `options.cancellable`, the `tui.select.cancel` keybinding aborts its `signal`.
 */
export function borderedLoader(
	theme: LoaderArgs[1],
	message: LoaderArgs[2],
	options?: LoaderArgs[3],
): Effect.Effect<BorderedLoader, never, Tui.Tui | Scope.Scope> {
	return Effect.acquireRelease(
		Tui.Tui.useSync((tui) => new BorderedLoader(tui, theme, message, options)),
		(made) => Effect.sync(() => made.dispose()),
	);
}

type BashArgs = ConstructorParameters<typeof BashExecutionComponent>;

/**
 * Pi's view of a user's shell command (`!command`, or `!!command` with `excludeFromContext`) for the running TUI: its
 * spinner runs until `setComplete`, or until the scope closes; `appendOutput` adds output.
 */
export function bashExecution(
	command: BashArgs[0],
	excludeFromContext?: BashArgs[2],
	outputPad?: BashArgs[3],
): Effect.Effect<BashExecutionComponent, never, Tui.Tui | Scope.Scope> {
	return Effect.acquireRelease(
		Tui.Tui.useSync((tui) => new BashExecutionComponent(command, tui, excludeFromContext, outputPad)),
		// Pi stops the spinner only in `setComplete`, which also sets the shown status; its private loader is the only
		// way to stop the timer of a command still shown as running.
		(made) => Effect.sync(() => (made as unknown as { readonly loader: { stop(): void } }).loader.stop()),
	);
}
