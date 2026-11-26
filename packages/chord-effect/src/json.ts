// `@effectified/pi-chord/json`: Chord's strict JSON, the value type of its documents and deltas, copied as an Effect.

import { type CopyJsonOptions, type JsonValue, copyJson as piCopyJson } from "@earendil-works/chord/json";
import { Effect } from "effect";
import { NotJson } from "./errors.ts";

// Chord's JSON types (`JsonValue`, `JsonRepresentation`, `CopyJsonOptions`).
export type * from "@earendil-works/chord/json";
// Whether a value is strict JSON: a total predicate.
export { isJsonValue } from "@earendil-works/chord/json";
export { NotJson } from "./errors.ts";

/**
 * Chord's `copyJson`: `value` as an alias-free strict-JSON tree the caller owns. Fails with `NotJson` where Chord
 * throws: a non-finite number, a cycle, a non-plain object or array, a symbol key, an accessor property.
 */
export function copyJson(value: unknown, options?: CopyJsonOptions): Effect.Effect<JsonValue, NotJson> {
	return Effect.try({
		try: () => piCopyJson(value, options),
		// Chord's copy throws only a `TypeError` that names what is not JSON.
		catch: (thrown) => new NotJson({ message: thrown instanceof Error ? thrown.message : String(thrown) }),
	});
}
