// pi-tui's color parser as an Effect: a color value from a theme or a setting, or `InvalidColor`.

import { type Color, parseColor as piParseColor } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { InvalidColor } from "./errors.ts";

/**
 * The color `value` names: a palette index (0-255), a hex color (`#rgb`, `#rrggbb`), `oklch()` or `okhsl()`. Fails
 * with `InvalidColor` where pi-tui throws: a value of no form it knows, or one out of its range, as a theme file's
 * typo would be.
 */
export function parseColor(value: string | number): Effect.Effect<Color, InvalidColor> {
	return Effect.try({
		try: () => piParseColor(value),
		// pi-tui's parser and the color constructors it calls throw only an `Error` that names the fault.
		catch: (thrown) =>
			new InvalidColor({ value, message: thrown instanceof Error ? thrown.message : String(thrown) }),
	});
}
