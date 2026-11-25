// Swarms for Pi Durable agents in Effect: prime once, fork per job under a cap with keyed forks, typed fan-in, and
// cleanup: the definition and the plan, the host operations, the driver port and the in-storage driver.

export * as ConversationForks from "./conversation-forks.ts";
export type { Coordinator } from "./coordinator.ts";
export {
	type Destroyed,
	Fork,
	ForkDriver,
	type ForkDriverService,
	ForkGone,
	type ForkRequest,
	ForkRetryLater,
	JobStatus,
	Notice,
	Place,
	type RunRequest,
} from "./driver.ts";
export { ForkSetupFailed, InvalidPlan, InvalidValue, SwarmFaulted, SwarmIdTaken, SwarmNotFound } from "./errors.ts";
export { events, type JobEvent } from "./events.ts";
export * as ForkSetup from "./fork-setup.ts";
export {
	cancel,
	destroyFork,
	type JobReport,
	result,
	type Started,
	type Status,
	start,
	status,
} from "./host.ts";
export { Reason, Status as JobState } from "./job.ts";
export { type Cleaned, type Ending, type JobOutcome, type Outcome, Stored, typed } from "./outcome.ts";
export { onStorageFork } from "./storage-fork.ts";
export { extension, make, named, type Plan, type PlannedJob, type Swarm, type SwarmExtension } from "./swarm.ts";
export type { Definition, JobRef, Work } from "./work.ts";
