// The codemode source format: JavaScript, optionally preceded by one `// @options:` line, parsed as an Effect. Also the
// entry of `@effectified/pi-codemode/source`, which needs no sandbox.

import {
	type ParsedCodemodeSource,
	CodemodeSourceError as PiCodemodeSourceError,
	parseCodemodeSource,
} from "@earendil-works/pi-codemode/source";
import { Effect, Result } from "effect";
import { CodemodeSourceError } from "./errors.ts";

export type { CodemodeSourceOptions, ParsedCodemodeSource } from "@earendil-works/pi-codemode/source";
// The options line's prefix and the Lark grammar of the format, for grammar-constrained tool input.
export { CODEMODE_OPTIONS_PREFIX, CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
export { CodemodeSourceError } from "./errors.ts";

/**
 * Splits an optional first-line `// @options: {...}` from the script; the options line becomes an empty line, so line
 * numbers stay. Fails with `CodemodeSourceError` for empty input, invalid options, and an options line that is not
 * the first line. The sandbox does not act on the options: the caller decides.
 */
export const parse = Effect.fn("Source.parse")(function* (
	input: string,
): Effect.fn.Return<ParsedCodemodeSource, CodemodeSourceError> {
	const parsed = Result.try(() => parseCodemodeSource(input));
	if (Result.isSuccess(parsed)) return parsed.success;
	// Pi throws its own class for every input it refuses; anything else is a defect of Pi.
	if (parsed.failure instanceof PiCodemodeSourceError) {
		return yield* CodemodeSourceError.make({ message: parsed.failure.message, cause: parsed.failure });
	}
	return yield* Effect.die(parsed.failure);
});
