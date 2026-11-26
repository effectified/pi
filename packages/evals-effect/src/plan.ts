// The plan of a documentation comparison: discovered cases checked, and expanded into one task per case, variant and
// run.

import {
	type DiscoveredEvalCase,
	type EvalTask,
	createTaskPlan as piCreateTaskPlan,
	parseDiscoveredCases as piParseDiscoveredCases,
} from "@earendil-works/pi-evals/src/plan.ts";
import { Effect } from "effect";
import { InvalidPlan, messageOf } from "./errors.ts";

/**
 * The cases Vitest discovered (`discovered-tests.json`, untyped JSON), each named `<eval set> > <case>` and unique.
 * Fails with `InvalidPlan` when one is not.
 */
export function parseDiscoveredCases(value: unknown): Effect.Effect<DiscoveredEvalCase[], InvalidPlan> {
	return Effect.try({ try: () => piParseDiscoveredCases(value), catch: invalidPlan });
}

/**
 * Every `(case, variant, run)` task of `model` (`<provider>/<model>`), `runsPerVariant` runs of each variant, the
 * order of the two variants alternating by run. Fails with `InvalidPlan` on a model without a provider or a count
 * that is not a positive integer.
 */
export function createTaskPlan(
	cases: readonly DiscoveredEvalCase[],
	model: string,
	runsPerVariant: number,
): Effect.Effect<EvalTask[], InvalidPlan> {
	return Effect.try({ try: () => piCreateTaskPlan(cases, model, runsPerVariant), catch: invalidPlan });
}

function invalidPlan(cause: unknown): InvalidPlan {
	return new InvalidPlan({ message: messageOf(cause) });
}
