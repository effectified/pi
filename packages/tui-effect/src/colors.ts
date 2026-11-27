// pi-tui's color parser as an Effect: a color value from a theme or a setting, or `InvalidColor`.

import { parseColor as piParseColor } from "@earendil-works/pi-tui";
import { Effect, Predicate } from "effect";
import { InvalidColor } from "./errors.ts";

/**
 * The color `value` names: a palette index (0-255), a hex color (`#rgb`, `#rrggbb`), `oklch()` or `okhsl()`. Fails
 * with `InvalidColor` where pi-tui throws: a value of no form it knows, or one out of its range, as a theme file's
 * typo would be.
 */
export const parseColor = Effect.fn("Tui.parseColor")((value: string | number) =>
	Effect.try({
		try: () => piParseColor(value),
		// pi-tui's parser and the color constructors it calls throw only an `Error` that names the fault.
		catch: (thrown) =>
			InvalidColor.make({ value, message: Predicate.isError(thrown) ? thrown.message : String(thrown) }),
	}),
);
