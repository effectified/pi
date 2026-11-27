// The plan of a documentation comparison: discovered cases read and checked, and expanded into one task per case,
// variant and run.

import {
	createTaskPlan as piCreateTaskPlan,
	parseDiscoveredCases as piParseDiscoveredCases,
} from "@earendil-works/pi-evals/src/plan.ts";
import { Effect, FileSystem, Schema } from "effect";
import { InvalidPlan, messageOf } from "./errors.ts";

/**
 * The cases Vitest discovered (`discovered-tests.json`, untyped JSON), each named `<eval set> > <case>` and unique.
 * Fails with `InvalidPlan` when one is not.
 */
export const parseDiscoveredCases = Effect.fn("Plan.parseDiscoveredCases")((value: unknown) =>
	Effect.try({ try: () => piParseDiscoveredCases(value), catch: invalidPlan }),
);

/** The text of a discovery file as the JSON value it holds, which Pi's `parseDiscoveredCases` checks. */
const DiscoveryJson = Schema.fromJsonString(Schema.Unknown);

/**
 * The cases of the `discovered-tests.json` at `path` (where `Docker.discoverCases` wrote it): read with `FileSystem`,
 * decoded from JSON and checked as `parseDiscoveredCases` does. Fails with `InvalidPlan` when the file is not JSON or
 * a case is invalid, and with the `PlatformError` of a file that cannot be read.
 */
export const readDiscoveredCases = Effect.fn("Plan.readDiscoveredCases")(function* (path: string) {
	const fileSystem = yield* FileSystem.FileSystem;
	const text = yield* fileSystem.readFileString(path);
	const value = yield* Schema.decodeEffect(DiscoveryJson)(text).pipe(
		Effect.mapError((error) => InvalidPlan.make({ message: `${path}: ${error.message}` })),
	);
	return yield* parseDiscoveredCases(value);
});

/**
 * Every `(case, variant, run)` task of `model` (`<provider>/<model>`), `runsPerVariant` runs of each variant, the
 * order of the two variants alternating by run. Fails with `InvalidPlan` on a model without a provider or a count
 * that is not a positive integer.
 */
export const createTaskPlan = Effect.fn("Plan.createTaskPlan")(
	(cases: Parameters<typeof piCreateTaskPlan>[0], model: string, runsPerVariant: number) =>
		Effect.try({ try: () => piCreateTaskPlan(cases, model, runsPerVariant), catch: invalidPlan }),
);

function invalidPlan(cause: unknown): InvalidPlan {
	return InvalidPlan.make({ message: messageOf(cause) });
}
