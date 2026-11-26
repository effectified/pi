// What a running TUI receives, as Streams: terminal input, the presses of keybindings, color scheme changes, SIGTSTP.

import {
	getKeybindings,
	isKeyRelease,
	type Keybinding,
	type TerminalColorScheme,
	type TuiInputListener,
} from "@earendil-works/pi-tui";
import { Effect, Queue, Stream } from "effect";
import { Tui } from "./tui-service.ts";

/**
 * Every input sequence the TUI receives (one key, one paste, one mouse report), observed and left to the TUI: the
 * focused component still gets it. Input an earlier listener consumed is not seen, such as the fullscreen TUI's own
 * scroll keys. Terminal replies the TUI answers itself (color and cell size reports) are not input.
 */
export const input: Stream.Stream<string, never, Tui> = listen((offer) => (data) => {
	offer(data);
	return undefined;
});

/**
 * The presses of `keybindings`, by name, taken from the TUI before the focused component sees them. Keys are matched
 * at each press against the keybindings pi-tui's components use (`setKeybindings`), so a user's configuration
 * applies; the first name in `keybindings` that matches wins. Key releases are left to the TUI.
 */
export function presses<K extends Keybinding>(keybindings: readonly K[]): Stream.Stream<K, never, Tui> {
	return listen((offer) => (data) => {
		if (isKeyRelease(data)) return undefined;
		const manager = getKeybindings();
		const pressed = keybindings.find((keybinding) => manager.matches(data, keybinding));
		if (pressed === undefined) return undefined;
		offer(pressed);
		return { consume: true };
	});
}

/** A TUI input listener for the life of the stream; `listener` hands its elements to `offer`. */
function listen<A>(listener: (offer: (value: A) => void) => TuiInputListener): Stream.Stream<A, never, Tui> {
	return Stream.callback<A, never, Tui>((queue) =>
		Effect.acquireRelease(
			Tui.useSync((tui) => tui.addInputListener(listener((value) => Queue.offerUnsafe(queue, value)))),
			(remove) => Effect.sync(remove),
		),
	);
}

/**
 * The terminal's color scheme each time it reports a change. A terminal reports only while the TUI asked it to
 * (pi-tui's `setTerminalColorSchemeNotifications(true)`); the stream does not ask.
 */
export const colorSchemes: Stream.Stream<TerminalColorScheme, never, Tui> = Stream.callback<
	TerminalColorScheme,
	never,
	Tui
>((queue) =>
	Effect.acquireRelease(
		Tui.useSync((tui) => tui.onTerminalColorSchemeChange((scheme) => Queue.offerUnsafe(queue, scheme))),
		(remove) => Effect.sync(remove),
	),
);

/**
 * One element per SIGTSTP (Ctrl+Z) the process gets while the TUI owns the terminal. While the stream runs, the
 * signal no longer suspends the process: the program decides, as pi-tui's `setSuspendSignalHandler` lets it. The
 * TUI has one such handler; when the stream ends, the signal suspends the process again.
 */
export const suspends: Stream.Stream<void, never, Tui> = Stream.callback<void, never, Tui>((queue) =>
	Effect.acquireRelease(
		Tui.useSync((tui) => {
			tui.setSuspendSignalHandler(() => Queue.offerUnsafe(queue, undefined));
			return tui;
		}),
		(tui) => Effect.sync(() => tui.setSuspendSignalHandler(undefined)),
	),
);
