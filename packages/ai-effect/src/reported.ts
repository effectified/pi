// The numbers pi-ai reports of a response (its tokens, costs, timings) as a Schema, and the rule that keeps them
// finite: a record keeps a finite number as reported and a non-finite one as 0.

import { Schema, SchemaTransformation } from "effect";

/**
 * A non-finite number as Schema's JSON form wrote it in records stored before 0.3.0 (`"NaN"`, `"Infinity"`,
 * `"-Infinity"`), read as 0: what a non-finite number is recorded as now.
 */
const Unrecorded = Schema.Literals(["NaN", "Infinity", "-Infinity"]).pipe(
	Schema.decodeTo(
		Schema.Finite,
		SchemaTransformation.transform({ decode: () => 0, encode: (): "NaN" | "Infinity" | "-Infinity" => "NaN" }),
	),
);

/**
 * A number pi-ai reports of a response, as a record of ours keeps it: any finite number, as reported. One that a
 * record stored before 0.3.0 kept as the string `"NaN"` (or an infinity) reads as 0, as `reported` records it now.
 */
export const Reported = Schema.Union([Schema.Finite, Unrecorded]);

/** A number pi-ai reported, ready for a record: `value` when it is finite, else 0. A trust boundary: a provider's. */
export function reported(value: number): number {
	return Number.isFinite(value) ? value : 0;
}
