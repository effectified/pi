// Parsing the JSON a model sent, with pi-ai's repair of its common mistakes, as an Effect with a typed failure.

import { formatThrownValue, parseJsonWithRepair as piParseJsonWithRepair } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { MalformedJson } from "./errors.ts";

/**
 * The value of `text` (pi-ai's `parseJsonWithRepair`): parsed as it is, or else after `repairJson` escaped the raw
 * control characters and stray backslashes models put in strings. Fails with `MalformedJson` when neither parses.
 * The value is unchecked: decode it with a `Schema`.
 */
export const parseJsonWithRepair = Effect.fn("Json.parseJsonWithRepair")(function* (
	text: string,
): Effect.fn.Return<unknown, MalformedJson> {
	return yield* Effect.try({
		try: () => piParseJsonWithRepair<unknown>(text),
		catch: (error) => MalformedJson.make({ text, message: formatThrownValue(error) }),
	});
});
