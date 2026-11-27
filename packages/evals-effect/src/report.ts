// The observations of a documentation comparison and their report: the observation of one task read from the Vitest
// JSON report of its container run, observations as a Schema for keeping them, and Pi's report as a Sink.

import { DOCUMENTATION_VARIANTS } from "@earendil-works/pi-evals/src/plan.ts";
import {
	type EvalComparisonReport,
	type ExpectedEvalRun,
	type EvalObservation as PiEvalObservation,
	readTaskObservation as piReadTaskObservation,
	summarizeEvalObservations,
} from "@earendil-works/pi-evals/src/report.ts";
import { Effect, Schema, Sink } from "effect";
import { ArtifactFailed, messageOf } from "./errors.ts";

/**
 * The outcome of `task` from the report at `reportPath`: scored, unscored, skipped, pending or errored, with the
 * run's tokens, tool calls, time and cost. A report that cannot be read, or that does not match the task, is an
 * `errored` observation, not a failure. The run's Pi session is written under `artifactDirectory`; a failed write
 * fails with `ArtifactFailed`.
 */
export const readTaskObservation = Effect.fn("Report.readTaskObservation")(
	(task: Parameters<typeof piReadTaskObservation>[0], reportPath: string, artifactDirectory: string) =>
		Effect.tryPromise({
			try: () => piReadTaskObservation(task, reportPath, artifactDirectory),
			catch: (cause) => ArtifactFailed.make({ message: messageOf(cause), cause }),
		}),
);

/** The fields that name one run of a comparison: Pi's `EvalRunIdentity`. */
const RUN_IDENTITY = {
	evalSet: Schema.String,
	// idiom-allow branded-id: Pi's own `EvalRunIdentity.caseId`, a plain string in every Pi function that takes one.
	caseId: Schema.String,
	variant: Schema.Literals(DOCUMENTATION_VARIANTS),
	model: Schema.String,
	runNumber: Schema.Int,
};

/** What a run measured, each where the run reported it. Pi writes an unreported one as `undefined`, not leaves it out. */
const METRICS = {
	inputTokens: Schema.optional(Schema.Finite),
	outputTokens: Schema.optional(Schema.Finite),
	cacheReadTokens: Schema.optional(Schema.Finite),
	cacheWriteTokens: Schema.optional(Schema.Finite),
	totalTokens: Schema.optional(Schema.Finite),
	toolCalls: Schema.optional(Schema.Finite),
	totalMs: Schema.optional(Schema.Finite),
	estimatedCostUsd: Schema.optional(Schema.Finite),
};

/**
 * Pi's `EvalObservation` as a Schema, the outcome of one run as `Docker.observe` streams it: a scored run and its
 * score, or a run that was not scored. For keeping observations in a file and reading them back, a line each with
 * `Schema.fromJsonString(Report.EvalObservation)`; `test/pi-conformance.ts` holds it equal to Pi's type.
 */
export const EvalObservation = Schema.Union([
	Schema.Struct({ ...RUN_IDENTITY, ...METRICS, outcome: Schema.Literal("scored"), score: Schema.Finite }),
	Schema.Struct({
		...RUN_IDENTITY,
		...METRICS,
		outcome: Schema.Literals(["unscored", "skipped", "pending", "errored"]),
	}),
]);

/** The outcome of one run of a comparison. */
export type EvalObservation = typeof EvalObservation.Type;

/**
 * Collects the observations of a comparison and gives Pi's report of them (`summarizeEvalObservations`) for the
 * runs `expectedRuns` planned: `Docker.observe(context, tasks).pipe(Stream.run(Report.summarize(digest, tasks)))`.
 */
export function summarize(
	protocolDigest: string,
	expectedRuns: readonly ExpectedEvalRun[],
): Sink.Sink<EvalComparisonReport, PiEvalObservation> {
	return Sink.map(Sink.collect<PiEvalObservation>(), (observations) =>
		summarizeEvalObservations(protocolDigest, expectedRuns, observations),
	);
}
