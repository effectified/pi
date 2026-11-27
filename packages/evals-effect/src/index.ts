// Pi's evals in Effect: the documentation-lift plan and report, the coding-agent eval harness and the container runner.

// pi-evals has no entry point of its own (it is a private package of Pi's workspace): its modules are its API. Every
// type they declare (`EvalTask`, `EvalObservation`, `EvalComparisonReport`, `PiCodingAgentInput`, ...), so an
// application names them without importing pi-evals.
export type * from "@earendil-works/pi-evals/src/docker.ts";
// The values pi-evals exports as they are: constants, and pure functions of observations and reports.
export { createDockerContext } from "@earendil-works/pi-evals/src/docker.ts";
export type * from "@earendil-works/pi-evals/src/harness.ts";
export { DOCUMENTATION_EVAL_TOOLS } from "@earendil-works/pi-evals/src/harness.ts";
export type * from "@earendil-works/pi-evals/src/plan.ts";
export { DOCUMENTATION_VARIANTS } from "@earendil-works/pi-evals/src/plan.ts";
export type * from "@earendil-works/pi-evals/src/report.ts";
export {
	erroredObservation,
	formatEvalComparisonReport,
	PI_SESSION_SNAPSHOT_ARTIFACT,
	summarizeEvalObservations,
} from "@earendil-works/pi-evals/src/report.ts";
// The run and the JSON values of vitest-evals, which a harness run is and resolves with.
export type { HarnessRun, JsonValue } from "vitest-evals/harness";
export * as Docker from "./docker.ts";
export * as Environment from "./environment.ts";
export {
	ArtifactFailed,
	DockerFailed,
	EvalsError,
	InvalidPlan,
	InvalidSetting,
	PromptMismatch,
	RunFailed,
} from "./errors.ts";
export * as Harness from "./harness.ts";
export * as Plan from "./plan.ts";
export * as Report from "./report.ts";
export * as SystemPrompt from "./system-prompt.ts";
