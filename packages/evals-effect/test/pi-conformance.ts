// What evals-effect writes by hand of pi-evals, checked against pi-evals' own types: each Effect form succeeds with
// what Pi's function returns, and the harness lifts every member of Pi's. Type-only: nothing here runs. A failure
// names what moved upstream.

import type * as PiDocker from "@earendil-works/pi-evals/src/docker.ts";
import type * as PiHarness from "@earendil-works/pi-evals/src/harness.ts";
import type * as PiPlan from "@earendil-works/pi-evals/src/plan.ts";
import type * as PiReport from "@earendil-works/pi-evals/src/report.ts";
import type { Effect, Stream } from "effect";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { Docker, Environment, Harness, Plan, Report, SystemPrompt } from "../src/index.ts";

/** The value an Effect form succeeds with. */
type Succeeds<F extends (...args: never[]) => Effect.Effect<unknown, unknown, never>> = Effect.Success<ReturnType<F>>;

/** The value Pi's function returns, awaited. */
type Returns<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type PlanTyped = Assert<
	Conform<
		[Succeeds<typeof Plan.parseDiscoveredCases>, Succeeds<typeof Plan.createTaskPlan>],
		[Returns<typeof PiPlan.parseDiscoveredCases>, Returns<typeof PiPlan.createTaskPlan>]
	>
>;

export type ReportTyped = Assert<
	Conform<Succeeds<typeof Report.readTaskObservation>, Returns<typeof PiReport.readTaskObservation>>
>;

/** `Report.EvalObservation` is Pi's `EvalObservation`, written as a Schema. */
export type ObservationMirrored = Assert<Conform<Report.EvalObservation, PiReport.EvalObservation>>;

/** `Plan.readDiscoveredCases` succeeds with what Pi's `parseDiscoveredCases` returns. */
export type ReadDiscoveredCasesTyped = Assert<
	Conform<Effect.Success<ReturnType<typeof Plan.readDiscoveredCases>>, Returns<typeof PiPlan.parseDiscoveredCases>>
>;

export type EnvironmentTyped = Assert<
	Conform<
		[Succeeds<typeof Environment.modelSelection>, Succeeds<typeof Environment.documentationVariant>],
		[Returns<typeof PiHarness.resolveModelSelection>, Returns<typeof PiHarness.resolveDocumentationVariant>]
	>
>;

export type SystemPromptTyped = Assert<
	Conform<
		[Succeeds<typeof SystemPrompt.verify>, Succeeds<typeof SystemPrompt.excludeDocumentation>],
		[Returns<typeof PiHarness.verifySystemPrompt>, Returns<typeof PiHarness.excludePiDocumentation>]
	>
>;

/** The runner's Effects, and each observation of `observe`: Pi's `EvalObservation`. */
export type DockerTyped = Assert<
	Conform<
		[
			Effect.Success<typeof Docker.buildImages>,
			Succeeds<typeof Docker.requireAuthFile>,
			Succeeds<typeof Docker.discoverCases>,
			Succeeds<typeof Docker.runTask>,
			Stream.Success<ReturnType<typeof Docker.observe>>,
		],
		[
			Returns<typeof PiDocker.buildImages>,
			Returns<typeof PiDocker.requireEvalAuthFile>,
			Returns<typeof PiDocker.discoverCases>,
			Returns<typeof PiDocker.runTask>,
			Returns<typeof PiReport.readTaskObservation>,
		]
	>
>;

/** Pi's harness: what `createPiCodingAgentHarness` makes without an output (its last overload). */
type PiAnswerHarness = ReturnType<typeof PiHarness.createPiCodingAgentHarness>;

/**
 * A run without an output succeeds with Pi's run of the agent's answer, and the harness has every member of Pi's: its
 * name, and its run, as an Effect.
 */
export type HarnessTyped = Assert<
	Conform<Effect.Success<ReturnType<Harness.EvalHarness<string>["run"]>>, Returns<PiAnswerHarness["run"]>>
>;
export type HarnessCovered = Assert<Covers<PiAnswerHarness, Harness.EvalHarness<string>>>;

/**
 * Every option of Pi's harness is one of `Harness.Options`, but `customTools`, whose `execute` is a promise
 * callback: its Effect form is the coding-agent facade's.
 */
export type OptionsCovered = Assert<Covers<PiHarness.PiCodingAgentHarnessOptions, Harness.Options, "customTools">>;
