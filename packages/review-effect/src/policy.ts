// The policy: who reviews, which family each model belongs to, how many corrective runs, and what blocks. Data the
// product supplies.

import { Option, Schema } from "effect";
import { Severity } from "./finding.ts";

/** A model as Pi names one: its provider and its id there. */
export const ModelRef = Schema.Struct({ provider: Schema.String, modelId: Schema.String });

/** A model as Pi names one. */
export type ModelRef = typeof ModelRef.Type;

/** One row of the family table: the family a model belongs to, in the product's own labels. */
export const Family = Schema.Struct({ provider: Schema.String, modelId: Schema.String, family: Schema.String });

/** One row of the family table. */
export type Family = typeof Family.Type;

/**
 * The whole policy of a review:
 *
 * - `reviewer`: the model that reads every answer.
 * - `families`: the family of each model the product uses, authors and reviewer. This package knows no model: one
 *   that is not listed has no family, and so has one listed twice with two labels.
 * - `maxCorrections`: how many times one run may be sent back for a correction before it is held. 0 holds at the
 *   first blocking finding.
 * - `blocking`: the lowest severity that blocks an answer. `block` always blocks.
 * - `instructions`: what the reviewer is told to look for, after this package's own instructions.
 */
export const Policy = Schema.Struct({
	reviewer: ModelRef,
	families: Schema.Array(Family),
	maxCorrections: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	blocking: Severity,
	instructions: Schema.optionalKey(Schema.String),
});

/** The whole policy of a review. */
export type Policy = typeof Policy.Type;

/** The family the table gives `model`: none when it is not listed, or listed under two labels. */
export function familyOf(families: ReadonlyArray<Family>, model: ModelRef): Option.Option<string> {
	const labels = new Set(
		families
			.filter((row) => row.provider === model.provider && row.modelId === model.modelId)
			.map((row) => row.family),
	);
	const [label] = labels;
	return labels.size === 1 ? Option.fromUndefinedOr(label) : Option.none();
}
