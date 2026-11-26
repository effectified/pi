import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ArtifactFailed, Report } from "../src/index.ts";
import { temporaryDirectory } from "./fixtures.ts";
import { SESSION, TASK, vitestReport } from "./vitest-report.ts";

/** The observation of `TASK` from a report with `contents` in a new directory, and that directory. */
function observe(contents: string | undefined) {
	return Effect.gen(function* () {
		const directory = yield* temporaryDirectory;
		const reportPath = join(directory, "vitest.json");
		if (contents !== undefined) yield* Effect.promise(() => writeFile(reportPath, contents));
		return { directory, observation: yield* Report.readTaskObservation(TASK, reportPath, directory) };
	});
}

describe("readTaskObservation", () => {
	it("reads a scored run with its metrics and keeps its session beside it", () =>
		runLive(
			Effect.gen(function* () {
				const { directory, observation } = yield* observe(vitestReport(0.5));
				expect(observation).toEqual({
					evalSet: TASK.evalSet,
					caseId: TASK.caseId,
					variant: TASK.variant,
					model: TASK.model,
					runNumber: 1,
					outcome: "scored",
					score: 0.5,
					inputTokens: 10,
					outputTokens: 5,
					totalTokens: 15,
					toolCalls: 1,
					totalMs: 1234,
				});
				const sessions = join(directory, TASK.variant, "sessions");
				const [hash] = yield* Effect.promise(() => readdir(sessions));
				expect(yield* Effect.promise(() => readFile(join(sessions, hash, "session.jsonl"), "utf8"))).toBe(SESSION);
			}),
		));

	it("records a run without a score as unscored, and a missing report as errored, not as a failure", () =>
		runLive(
			Effect.gen(function* () {
				expect((yield* observe(vitestReport(null))).observation.outcome).toBe("unscored");
				expect((yield* observe(undefined)).observation.outcome).toBe("errored");
			}),
		));

	it("fails with ArtifactFailed when the session cannot be written", () =>
		runLive(
			Effect.gen(function* () {
				const directory = yield* temporaryDirectory;
				const reportPath = join(directory, "vitest.json");
				yield* Effect.promise(() => writeFile(reportPath, vitestReport(1)));
				// A file where the artifact directory should be: the session's directory cannot be made under it.
				const failure = yield* Effect.flip(Report.readTaskObservation(TASK, reportPath, reportPath));
				expect(failure).toBeInstanceOf(ArtifactFailed);
				expect(failure.message).toContain("vitest.json");
			}),
		));
});
