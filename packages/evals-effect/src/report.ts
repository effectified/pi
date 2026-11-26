// The observation of one task: read from the Vitest JSON report of its container run, its session kept beside it.

import type { EvalTask } from "@earendil-works/pi-evals/src/plan.ts";
import {
	type EvalObservation,
	readTaskObservation as piReadTaskObservation,
} from "@earendil-works/pi-evals/src/report.ts";
import { Effect } from "effect";
import { ArtifactFailed, messageOf } from "./errors.ts";

/**
 * The outcome of `task` from the report at `reportPath`: scored, unscored, skipped, pending or errored, with the
 * run's tokens, tool calls, time and cost. A report that cannot be read, or that does not match the task, is an
 * `errored` observation, not a failure. The run's Pi session is written under `artifactDirectory`; a failed write
 * fails with `ArtifactFailed`.
 */
export function readTaskObservation(
	task: EvalTask,
	reportPath: string,
	artifactDirectory: string,
): Effect.Effect<EvalObservation, ArtifactFailed> {
	return Effect.tryPromise({
		try: () => piReadTaskObservation(task, reportPath, artifactDirectory),
		catch: (cause) => new ArtifactFailed({ message: messageOf(cause), cause }),
	});
}
