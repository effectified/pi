// What the terminal can show (images, true color, hyperlinks) and its cell size: pi-tui's process-wide state, as Effects.

import {
	type CellDimensions,
	detectCapabilities as piDetectCapabilities,
	getCapabilities as piGetCapabilities,
	getCellDimensions as piGetCellDimensions,
	getTerminalColorMode as piGetTerminalColorMode,
	resetCapabilitiesCache as piResetCapabilitiesCache,
	setCapabilities as piSetCapabilities,
	setCapabilityOverrides as piSetCapabilityOverrides,
	setCellDimensions as piSetCellDimensions,
	type TerminalCapabilities,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";

/**
 * What the terminal of this process can show, detected from its environment (`TERM_PROGRAM`, `COLORTERM`, the
 * `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR` and `PI_HYPERLINKS` overrides; inside tmux, by asking tmux), without caching.
 */
export const detectCapabilities: Effect.Effect<TerminalCapabilities> = Effect.sync(() => piDetectCapabilities());

/** The capabilities pi-tui renders with: detected once and cached, with the overrides set by `setCapabilityOverrides`. */
export const getCapabilities: Effect.Effect<TerminalCapabilities> = Effect.sync(piGetCapabilities);

/** Replaces the cached capabilities, until `resetCapabilitiesCache` or `setCapabilityOverrides`. */
export function setCapabilities(capabilities: TerminalCapabilities): Effect.Effect<void> {
	return Effect.sync(() => piSetCapabilities(capabilities));
}

/** Overrides some detected capabilities, such as a user's setting to show no images; detection runs again. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): Effect.Effect<void> {
	return Effect.sync(() => piSetCapabilityOverrides(overrides));
}

/** Drops the cached capabilities, so the next render detects them again. */
export const resetCapabilitiesCache: Effect.Effect<void> = Effect.sync(piResetCapabilitiesCache);

/** The color mode text is styled for: `"truecolor"` when `capabilities` (default: the cached ones) has true color. */
export function getTerminalColorMode(capabilities?: TerminalCapabilities): Effect.Effect<TerminalColorMode> {
	return Effect.sync(() => piGetTerminalColorMode(capabilities));
}

/** The size of one terminal cell in pixels, which images are scaled by; a running TUI asks the terminal for it. */
export const getCellDimensions: Effect.Effect<CellDimensions> = Effect.sync(piGetCellDimensions);

/** Sets the size of one terminal cell in pixels. */
export function setCellDimensions(dimensions: CellDimensions): Effect.Effect<void> {
	return Effect.sync(() => piSetCellDimensions(dimensions));
}
