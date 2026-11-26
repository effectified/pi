// The keybindings pi-tui's components read (a process-wide `KeybindingsManager`), read and set as Effects.

import {
	type KeybindingsManager,
	getKeybindings as piGetKeybindings,
	setKeybindings as piSetKeybindings,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";

/**
 * The keybindings pi-tui's components and `Tui.presses` match keys against: the manager `setKeybindings` set, or
 * one of pi-tui's defaults (`TUI_KEYBINDINGS`), made on first read.
 */
export const getKeybindings: Effect.Effect<KeybindingsManager> = Effect.sync(piGetKeybindings);

/**
 * Makes `keybindings` the ones pi-tui's components read, for the whole process. Build it with `KeybindingsManager`
 * from the program's definitions (pi-tui's `TUI_KEYBINDINGS` and its own) and the user's configuration, so keys stay
 * configurable.
 */
export function setKeybindings(keybindings: KeybindingsManager): Effect.Effect<void> {
	return Effect.sync(() => piSetKeybindings(keybindings));
}
