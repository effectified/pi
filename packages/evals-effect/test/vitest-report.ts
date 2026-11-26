// A task of a documentation comparison and the Vitest JSON report its container run writes, as Pi's runner reads it.

import { type EvalTask, PI_SESSION_SNAPSHOT_ARTIFACT } from "../src/index.ts";

/** One task of a plan. */
export const TASK: EvalTask = {
	file: "evals/example.docs.eval.ts",
	fullName: "Example workflow > handles the case",
	evalSet: "Example workflow",
	caseId: "handles the case",
	variant: "with_docs",
	model: "fixture/model",
	runNumber: 1,
};

/** The session snapshot its run records. */
export const SESSION = '{"type":"session"}\n';

/** A Vitest JSON report of one passed case whose harness run scored `score` (`null`: unscored). */
export function vitestReport(score: number | null) {
	const run = {
		output: { ok: true },
		session: { events: [{ type: "message", role: "user", content: "prompt" }] },
		usage: { provider: "fixture", model: "model", inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 1 },
		timings: { totalMs: 1234 },
		artifacts: { runId: "run-1", [PI_SESSION_SNAPSHOT_ARTIFACT]: SESSION },
		errors: [],
	};
	const result = {
		ancestorTitles: [TASK.evalSet],
		fullName: `${TASK.evalSet} ${TASK.caseId}`,
		status: "passed",
		title: TASK.caseId,
		failureMessages: [],
		meta: { eval: { avgScore: score, scores: [], thresholdFailed: false }, harness: { name: "with_docs", run } },
	};
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [
			{ message: "", name: "/repo/evals/example.docs.eval.ts", status: "passed", assertionResults: [result] },
		],
	});
}
