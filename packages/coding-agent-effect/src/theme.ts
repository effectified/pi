// pi-coding-agent's theme in Effect: choosing the theme interactive mode and its components draw with, for the process.

import { initTheme as piInitTheme } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

/**
 * Makes `themeName` (default: Pi's system theme, which follows the terminal's colors) the theme of the whole process:
 * what interactive mode, its components and the theme helpers (`keyHint`, `highlightCode`, `getMarkdownTheme`, ...)
 * draw with. Run it before `InteractiveMode.make`, with the settings' theme, as Pi's CLI does. A theme Pi cannot load
 * falls back to the system theme, as in Pi. `enableWatcher` reloads a custom theme when its file changes, for the
 * rest of the process. Not scoped: Pi offers no way to read the theme it replaces, nor to stop the watcher.
 */
export const initTheme = Effect.fn("Theme.initTheme")((themeName?: string, enableWatcher?: boolean) =>
	Effect.sync(() => piInitTheme(themeName, enableWatcher)),
);
