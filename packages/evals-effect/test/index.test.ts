// What this package does with every value pi-evals exports. pi-evals has no entry point (it is a private package of
// Pi's workspace), so each of its modules has its own record.

import type * as PiCli from "@earendil-works/pi-evals/src/cli.ts";
import * as PiDocker from "@earendil-works/pi-evals/src/docker.ts";
import * as PiHarness from "@earendil-works/pi-evals/src/harness.ts";
import * as PiPlan from "@earendil-works/pi-evals/src/plan.ts";
import * as PiReport from "@earendil-works/pi-evals/src/report.ts";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";

const offered: Coverage = { kind: "offered" };
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** `src/plan.ts`: the plan of a documentation comparison. */
const PLAN = {
	DOCUMENTATION_VARIANTS: offered,
	parseDiscoveredCases: replaced("Plan.parseDiscoveredCases"),
	createTaskPlan: replaced("Plan.createTaskPlan"),
} satisfies Record<keyof typeof PiPlan, Coverage>;

/** `src/report.ts`: observations and the paired report. */
const REPORT = {
	PI_SESSION_SNAPSHOT_ARTIFACT: offered,
	erroredObservation: offered,
	readTaskObservation: replaced("Report.readTaskObservation"),
	summarizeEvalObservations: offered,
	formatEvalComparisonReport: offered,
} satisfies Record<keyof typeof PiReport, Coverage>;

/** `src/harness.ts`: the coding-agent harness and the settings and prompt checks of its runs. */
const HARNESS = {
	resolveModelSelection: replaced("Environment.modelSelection"),
	applyIsolatedEnvironment: replaced("Environment.isolated: the environment for a scope"),
	verifySystemPrompt: replaced("SystemPrompt.verify"),
	createPiCodingAgentHarness: replaced(
		"Harness.make: a run is an Effect, interruption aborts it, the output is an Effect with the caller's services; " +
			"customTools are left for the coding-agent facade",
	),
	DOCUMENTATION_EVAL_TOOLS: offered,
	resolveDocumentationVariant: replaced("Environment.documentationVariant"),
	excludePiDocumentation: replaced("SystemPrompt.excludeDocumentation"),
	createPiDocumentationEvalHarness: replaced("Harness.makeDocumentation"),
} satisfies Record<keyof typeof PiHarness, Coverage>;

/** `src/docker.ts`: the container runner. */
const DOCKER = {
	buildImages: replaced("Docker.buildImages"),
	requireEvalAuthFile: replaced("Docker.requireAuthFile"),
	createDockerContext: offered,
	discoverCases: replaced("Docker.discoverCases"),
	runTask: replaced("Docker.runTask, and Docker.observe: a plan's observations as a Stream"),
} satisfies Record<keyof typeof PiDocker, Coverage>;

/**
 * `src/cli.ts`: the comparison runner is a script that runs when it is imported and exports nothing. Its loop over
 * the plan is `Docker.observe`; the rest is the modules above.
 */
const CLI = {} satisfies Record<keyof typeof PiCli, Coverage>;

const MODULES = [
	["plan", PLAN, PiPlan],
	["report", REPORT, PiReport],
	["harness", HARNESS, PiHarness],
	["docker", DOCKER, PiDocker],
] as const;

describe("the coverage of pi-evals", () => {
	it("offers every value it records as offered, Pi's own and not copies", () => {
		const offeredValues = MODULES.flatMap(([, coverage, pi]) =>
			Object.entries(coverage)
				.filter(([, entry]) => entry === offered)
				.map(([name]) => [name, pi[name as keyof typeof pi]] as const),
		);
		expect(offeredValues.map(([name]) => name).sort()).toEqual([
			"DOCUMENTATION_EVAL_TOOLS",
			"DOCUMENTATION_VARIANTS",
			"PI_SESSION_SNAPSHOT_ARTIFACT",
			"createDockerContext",
			"erroredObservation",
			"formatEvalComparisonReport",
			"summarizeEvalObservations",
		]);
		const exported = new Map(Object.entries(Package));
		for (const [name, value] of offeredValues) expect(exported.get(name)).toBe(value);
	});

	it("records every value of every module, and has no open entries", () => {
		for (const [, coverage, pi] of MODULES) expect(Object.keys(coverage).sort()).toEqual(Object.keys(pi).sort());
		expect(Object.keys(CLI)).toEqual([]);
		const kinds = MODULES.flatMap(([, coverage]) => Object.values(coverage).map((entry) => entry.kind));
		expect(kinds.filter((kind) => kind === "open")).toEqual([]);
	});

	it("has every Effect form it names", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"ArtifactFailed",
			"DOCUMENTATION_EVAL_TOOLS",
			"DOCUMENTATION_VARIANTS",
			"Docker",
			"DockerFailed",
			"Environment",
			"EvalsError",
			"Harness",
			"InvalidPlan",
			"InvalidSetting",
			"PI_SESSION_SNAPSHOT_ARTIFACT",
			"Plan",
			"PromptMismatch",
			"Report",
			"RunFailed",
			"SystemPrompt",
			"createDockerContext",
			"erroredObservation",
			"formatEvalComparisonReport",
			"summarizeEvalObservations",
		]);
		expect(Object.keys(Package.Plan).sort()).toEqual([
			"createTaskPlan",
			"parseDiscoveredCases",
			"readDiscoveredCases",
		]);
		expect(Object.keys(Package.Report).sort()).toEqual(["EvalObservation", "readTaskObservation", "summarize"]);
		expect(Object.keys(Package.Environment).sort()).toEqual(["documentationVariant", "isolated", "modelSelection"]);
		expect(Object.keys(Package.SystemPrompt).sort()).toEqual(["excludeDocumentation", "verify"]);
		expect(Object.keys(Package.Harness).sort()).toEqual(["make", "makeDocumentation"]);
		expect(Object.keys(Package.Docker).sort()).toEqual([
			"buildImages",
			"discoverCases",
			"observe",
			"requireAuthFile",
			"runTask",
		]);
	});
});
