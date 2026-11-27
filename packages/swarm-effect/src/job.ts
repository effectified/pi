// A job of a swarm as its coordinator stores it: planned, starting, running, succeeded or failed.

import { Schema } from "effect";
import { Place } from "./driver.ts";
import { ForkId } from "./ids.ts";

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

/** A number of answers in a row, of corrections or of looks. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** How a running job's coordinator waits for it. Times are on the harness clock, in milliseconds. */
export const Wait = Schema.TaggedUnion({
	/** Asleep on the signal `signal`, under the job's notify key, until it is delivered. */
	Signal: { signal: Schema.String },
	/**
	 * Asks the driver once the harness clock reaches `at`, and every `everyMillis` after that while the job runs.
	 * `everyMillis` is the driver's interval as it was given, any finite number: 0.2.0 stored a negative one (the
	 * Rivet driver's `pollMillis: -1`), which asks again at once.
	 */
	Poll: { at: Schema.Finite, everyMillis: Schema.Finite },
});

/** How a running job's coordinator waits for it. */
export type Wait = typeof Wait.Type;

/** No fork yet, and nothing was asked of the driver. */
export const Planned = Schema.Struct({ status: Schema.Literal("planned") });

/**
 * Its fork, or the job in it, was asked for and the driver answered "retry later": asked again at `retryAt`. It
 * holds a place under the cap, since its fork may exist already.
 */
export const Starting = Schema.Struct({
	status: Schema.Literal("starting"),
	fork: Schema.NullOr(ForkId),
	/** "Retry later" answers in a row that count: after `MAX_ATTEMPTS` of them the job fails. */
	attempts: Count,
	/** Answers in a row that said the source is busy: they are waited out, and only pace the next look. */
	busy: Count,
	retryAt: Schema.Finite,
});

/** Its fork works on it: the request of `correction` (0 is the job itself) is accepted and has not been read. */
export const Running = Schema.Struct({
	status: Schema.Literal("running"),
	fork: ForkId,
	correction: Count,
	wait: Wait,
	/** "Retry later" answers in a row since the driver last answered. */
	attempts: Count,
	/** Where the job runs, when its driver said so. */
	ran: Schema.NullOr(Place),
});

/** Its answer decoded: `value` is the result as the schema encodes it. */
export const Succeeded = Schema.Struct({
	status: Schema.Literal("succeeded"),
	fork: ForkId,
	value: Schema.Json,
	/** Where the job ran, when its driver said so. */
	ran: Schema.NullOr(Place),
});

/** It has no result, and never will. */
export const Failed = Schema.Struct({
	status: Schema.Literal("failed"),
	fork: Schema.NullOr(ForkId),
	reason: Reason,
	message: Schema.String,
	/** Where the job ran, when it got as far as a request its fork accepted and the driver said where. */
	ran: Schema.NullOr(Place),
});

/** One job, in the order of the plan: its key is the plan's at the same index. Choose with `Job.match`. */
export const Job = Schema.Union([Planned, Starting, Running, Succeeded, Failed]).pipe(Schema.toTaggedUnion("status"));

/** One job as the coordinator stores it. */
export type Job = typeof Job.Type;

/** A job that holds a place under the cap: its fork may exist, and its work has not settled. */
export const Live = Schema.Union([Starting, Running]);

/** A job that holds a place under the cap. */
export type Live = typeof Live.Type;

/** A job with its result or its failure. Choose with `Settled.match`. */
export const Settled = Schema.Union([Succeeded, Failed]).pipe(Schema.toTaggedUnion("status"));

/** A job with its result or its failure. */
export type Settled = typeof Settled.Type;

/** A job's status, as `status` and the job events report it. */
export const Status = Schema.Literals(Job.discriminants);

/** A job's status. */
export type Status = typeof Status.Type;

/** The state every job of a new swarm starts in. */
export const planned: typeof Planned.Type = Planned.make({ status: "planned" });

/** A failed job; `ran` for one whose fork had accepted a request. */
export function failed(
	fork: ForkId | null,
	reason: Reason,
	message: string,
	ran: Place | null = null,
): typeof Failed.Type {
	return Failed.make({ status: "failed", fork, reason, message, ran });
}

/** Whether the job holds a place under the cap. */
export const isLive = Job.isAnyOf(["starting", "running"]);

/** Whether the job has its result or its failure. */
export const isSettled = Job.isAnyOf(["succeeded", "failed"]);

/** Whether the job has no fork yet and nothing was asked for it. */
export const isPlanned = Job.isAnyOf(["planned"]);

/** Where the job ran, as far as its state says. */
export function ranOf(job: Job): Place | null {
	return hasNoRequest(job) ? null : job.ran;
}

// The states before a fork accepted a request of the job: nothing says where it runs yet.
const hasNoRequest = Job.isAnyOf(["planned", "starting"]);

/** The job as cancelled, unless it settled already: what a cancelled or failed swarm makes of its open jobs. */
export function cancelled(job: Job, why: string): Settled {
	return Job.match(job, {
		planned: () => failed(null, "cancelled", why),
		starting: ({ fork }) => failed(fork, "cancelled", why),
		running: ({ fork, ran }) => failed(fork, "cancelled", why, ran),
		succeeded: (settled) => settled,
		failed: (settled) => settled,
	});
}
