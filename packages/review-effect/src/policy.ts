// The policy: who reviews, which family each model belongs to, how many corrective runs, and what blocks. Data the
// product supplies.

import { ModelRef as PiModelRef } from "@effectified/pi-ai";
import { Array as Arr, Option, Schema } from "effect";
import { dual } from "effect/Function";
import { Severity } from "./finding.ts";

/** A model as Pi names one: its provider and its id there. The schema of Pi's `ModelRef`, `@effectified/pi-ai`'s. */
export const ModelRef = PiModelRef;

/** A model as Pi names one. */
export type ModelRef = PiModelRef;

/**
 * One row of the family table: the family a model belongs to, in the product's own labels. The model's ids are
 * branded as `ModelRef`'s; decoding a policy brands them.
 */
export const Family = Schema.Struct({ ...ModelRef.fields, family: Schema.String });

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

/** Whether a row of the family table and a model name the same model: the same provider and the same id. */
const sameModel = Schema.toEquivalence(ModelRef);

/**
 * The family the table gives `model`: none when it is not listed, or listed under two labels. Data-first, or
 * data-last on the table.
 */
export const familyOf: {
	(model: ModelRef): (families: ReadonlyArray<Family>) => Option.Option<string>;
	(families: ReadonlyArray<Family>, model: ModelRef): Option.Option<string>;
} = dual(2, (families: ReadonlyArray<Family>, model: ModelRef): Option.Option<string> => {
	const rows = Arr.filter(families, (row) => sameModel(row, model));
	const labels = Arr.dedupe(Arr.map(rows, (row) => row.family));
	return labels.length === 1 ? Arr.head(labels) : Option.none();
});
