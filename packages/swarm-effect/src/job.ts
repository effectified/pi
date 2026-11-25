// A job of a swarm as its coordinator stores it: planned, starting, running, succeeded or failed.

import { Schema } from "effect";
import { Place } from "./driver.ts";

/** Why a job failed. */
export const Reason = Schema.Literals([
	/** The fork settled without an answer; the message holds its reason. */
	"unanswered",
	/** The fork's answers did not decode against the result schema, corrections included. */
	"invalid-result",
	/** The stored input does not decode against the definition's input schema. */
	"invalid-input",
	/** The driver answered "retry later" until the attempts ran out. */
	"driver-unavailable",
	/** The fork or the source is gone, or the fork lost the job it had accepted. */
	"gone",
	/** The source is a fork of forks as deep as the engine allows: no job of it can have a fork. */
	"too-deep",
	/** The swarm was cancelled, or failed with `onFailure: "fail"`, before the job settled. */
	"cancelled",
]);

/** Why a job failed. */
export type Reason = typeof Reason.Type;

/** How a running job's coordinator waits for it. */
export const Wait = Schema.Union([
	/** Asleep on the signal `signal`, under the job's notify key, until it is delivered. */
	Schema.TaggedStruct("Signal", { signal: Schema.String }),
	/** Asks the driver once the harness clock reaches `at`, and every `everyMillis` after that while the job runs. */
	Schema.TaggedStruct("Poll", { at: Schema.Number, everyMillis: Schema.Number }),
]);

/** No fork yet, and nothing was asked of the driver. */
export const Planned = Schema.Struct({ status: Schema.Literal("planned") });

/**
 * Its fork, or the job in it, was asked for and the driver answered "retry later": asked again at `retryAt`. It
 * holds a place under the cap, since its fork may exist already.
 */
export const Starting = Schema.Struct({
	status: Schema.Literal("starting"),
	fork: Schema.NullOr(Schema.String),
	/** "Retry later" answers in a row that count: after `MAX_ATTEMPTS` of them the job fails. */
	attempts: Schema.Number,
	/** Answers in a row that said the source is busy: they are waited out, and only pace the next look. */
	busy: Schema.Number,
	retryAt: Schema.Number,
});

/** Its fork works on it: the request of `correction` (0 is the job itself) is accepted and has not been read. */
export const Running = Schema.Struct({
	status: Schema.Literal("running"),
	fork: Schema.String,
	correction: Schema.Number,
	wait: Wait,
	/** "Retry later" answers in a row since the driver last answered. */
	attempts: Schema.Number,
	/** Where the job runs, when its driver said so. */
	ran: Schema.NullOr(Place),
});

/** Its answer decoded: `value` is the result as the schema encodes it. */
export const Succeeded = Schema.Struct({
	status: Schema.Literal("succeeded"),
	fork: Schema.String,
	value: Schema.Json,
	/** Where the job ran, when its driver said so. */
	ran: Schema.NullOr(Place),
});

/** It has no result, and never will. */
export const Failed = Schema.Struct({
	status: Schema.Literal("failed"),
	fork: Schema.NullOr(Schema.String),
	reason: Reason,
	message: Schema.String,
	/** Where the job ran, when it got as far as a request its fork accepted and the driver said where. */
	ran: Schema.NullOr(Place),
});

/** One job, in the order of the plan: its key is the plan's at the same index. */
export const Job = Schema.Union([Planned, Starting, Running, Succeeded, Failed]);

/** One job as the coordinator stores it. */
export type Job = typeof Job.Type;

/** A job that holds a place under the cap: its fork may exist, and its work has not settled. */
export type Live = typeof Starting.Type | typeof Running.Type;

/** A job with its result or its failure. */
export type Settled = typeof Succeeded.Type | typeof Failed.Type;

/** A job's status, as `status` and the job events report it. */
export const Status = Schema.Literals(["planned", "starting", "running", "succeeded", "failed"]);

/** A job's status. */
export type Status = typeof Status.Type;

/** The state every job of a new swarm starts in. */
export const planned: typeof Planned.Type = { status: "planned" };

/** A failed job; `ran` for one whose fork had accepted a request. */
export function failed(
	fork: string | null,
	reason: Reason,
	message: string,
	ran: Place | null = null,
): typeof Failed.Type {
	return { status: "failed", fork, reason, message, ran };
}

/** Where the job ran, as far as its state says. */
export function ranOf(job: Job): Place | null {
	return job.status === "planned" || job.status === "starting" ? null : job.ran;
}

/** Whether the job holds a place under the cap. */
export function isLive(job: Job): job is Live {
	return job.status === "starting" || job.status === "running";
}

/** Whether the job has its result or its failure. */
export function isSettled(job: Job): job is Settled {
	return job.status === "succeeded" || job.status === "failed";
}

/** The job as cancelled, unless it settled already: what a cancelled or failed swarm makes of its open jobs. */
export function cancelled(job: Job, why: string): Settled {
	switch (job.status) {
		case "succeeded":
		case "failed":
			return job;
		case "planned":
			return failed(null, "cancelled", why);
		case "starting":
			return failed(job.fork, "cancelled", why);
		case "running":
			return failed(job.fork, "cancelled", why, job.ran);
	}
}
