// The state of the terminal a running TUI draws on, as Effects: its title, progress, program status and pending input.

import { type ProgramStatus, isAppleTerminalSession as piIsAppleTerminalSession } from "@earendil-works/pi-tui";
import { Effect, type Scope } from "effect";
import { Tui } from "./tui-service.ts";

/** Sets the terminal window's title (OSC 0); control characters in `title` are replaced, as pi-tui does. */
export function setTitle(title: string): Effect.Effect<void, never, Tui> {
	return Tui.useSync((tui) => tui.terminal.setTitle(title));
}

/**
 * Reports what the program is doing (OSC 7501), to terminals that support it. pi-tui keeps the latest status and
 * reports it again when the terminal restarts; `{ state: "clear" }` removes it.
 */
export function setProgramStatus(status: ProgramStatus): Effect.Effect<void, never, Tui> {
	return Tui.useSync((tui) => tui.terminal.setProgramStatus(status));
}

/**
 * Shows the terminal's busy indicator (OSC 9;4) until the scope closes. pi-tui repeats it every second meanwhile, so
 * a terminal that drops it shows it again.
 */
export const progress: Effect.Effect<void, never, Tui | Scope.Scope> = Effect.acquireRelease(
	Tui.useSync((tui) => {
		tui.terminal.setProgress(true);
		return tui;
	}),
	(tui) => Effect.sync(() => tui.terminal.setProgress(false)),
);

/**
 * Reads and drops the input still on its way from the terminal (pi-tui's `drainInput`), so the key release events of
 * the Kitty protocol do not reach the shell after exit over a slow connection. Run it before the TUI's scope closes.
 * Waits at most `maxMs` (default 1000), and ends early once no input came for `idleMs` (default 50), on pi-tui's own
 * timers. Turns the Kitty keyboard protocol off first.
 */
export function drainInput(
	options: { readonly maxMs?: number; readonly idleMs?: number } = {},
): Effect.Effect<void, never, Tui> {
	return Tui.use((tui) => Effect.promise(() => tui.terminal.drainInput(options.maxMs, options.idleMs)));
}

/** Whether this process runs in macOS's Terminal.app, which sends some keys differently (pi-tui's check). */
export const isAppleTerminalSession: Effect.Effect<boolean> = Effect.sync(piIsAppleTerminalSession);
