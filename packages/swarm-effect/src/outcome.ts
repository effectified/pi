// The result of a swarm: per job a success or a failure, in job order, and what became of every fork.

import { Array as Arr, Effect, Option, Schema } from "effect";
import { Bytes, Place } from "./driver.ts";
import type { InvalidValue } from "./errors.ts";
import { ForkId, JobKey, SwarmId } from "./ids.ts";
import { Reason, Settled } from "./job.ts";
import type { Work } from "./work.ts";

/** What became of one fork when the swarm ended, as stored. */
export const Fate = Schema.Struct({
	jobKey: JobKey,
	forkId: ForkId,
	/** `destroyed` through the driver; `pinned`, so kept; `left`, because the driver could not destroy it. */
	fate: Schema.Literals(["destroyed", "pinned", "left"]),
	/** The bytes the fork wrote, when it was destroyed and the driver knew them. */
	bytesWritten: Schema.NullOr(Bytes),
	/** Where the fork's job ran, when its driver said so: the conversation, and the actor for a fork that is one. */
	ran: Schema.NullOr(Place),
});

/** What clean-up knows of one fork: everything of its fate but where its job ran, which the job's state holds. */
export type Disposed = Omit<typeof Fate.Type, "ran">;

/** One job's result as stored: `value` is the result as its schema encodes it. Choose with `StoredJob.match`. */
export const StoredJob = Schema.TaggedUnion({
	Success: { key: JobKey, value: Schema.Json },
	Failure: { key: JobKey, reason: Reason, message: Schema.String },
});

/** One job's result as stored. */
export type StoredJob = typeof StoredJob.Type;

/** How a swarm ended: every job was run, a job failed under `onFailure: "fail"`, or the swarm was cancelled. */
export const Ending = Schema.Literals(["completed", "failed", "cancelled"]);

/** How a swarm ended. */
export type Ending = typeof Ending.Type;

/** A swarm's result as the coordinator task stores it: the task's result, with results as stored JSON. */
export const Stored = Schema.Struct({
	swarmId: SwarmId,
	ending: Ending,
	jobs: Schema.Array(StoredJob),
	forks: Schema.Array(Fate),
});

/** A swarm's result as stored. */
export type Stored = typeof Stored.Type;

/**
 * What became of one fork when the swarm ended: its stored fate, with an `Option` where that has null. `ran` is where
 * the fork's job ran, when its driver said so: the conversation in the fork's harness storage, and the actor that
 * holds that storage for a fork that is an actor. It is how a host attributes a fork's spend and records to its
 * swarm. None for a fork whose job never got a request accepted.
 */
export const Cleaned = Schema.Struct({ ...Fate.fields, bytesWritten: Schema.Option(Bytes), ran: Schema.Option(Place) });

/** What became of one fork when the swarm ended. */
export type Cleaned = typeof Cleaned.Type;

/** One job's result: the typed value, or why there is none. Its stored form with `value` decoded. */
export type JobOutcome<A> =
	| Exclude<StoredJob, { readonly _tag: "Success" }>
	| (Omit<Extract<StoredJob, { readonly _tag: "Success" }>, "value"> & { readonly value: A });

/** A swarm's result: its jobs in the order of the plan, each with its typed value or its failure, and its forks. */
export interface Outcome<A> extends Omit<Stored, "jobs" | "forks"> {
	readonly jobs: ReadonlyArray<JobOutcome<A>>;
	readonly forks: ReadonlyArray<Cleaned>;
}

/**
 * The stored result of a swarm whose jobs, in the order of `keys`, have all settled. Each fork is given the place its
 * job ran in, from the job of its key.
 */
export function of(
	swarmId: SwarmId,
	ending: Ending,
	keys: ReadonlyArray<JobKey>,
	jobs: ReadonlyArray<Settled>,
	forks: ReadonlyArray<Disposed>,
): Stored {
	const keyed = Arr.zip(keys, jobs);
	// One lookup per fork, whatever the number of jobs.
	const byKey = new Map(keyed);
	const ranOf = (jobKey: JobKey): Place | null => byKey.get(jobKey)?.ran ?? null;
	return {
		swarmId,
		ending,
		jobs: Arr.map(keyed, ([key, job]) =>
			Settled.match(job, {
				succeeded: ({ value }) => StoredJob.cases.Success.make({ key, value }),
				failed: ({ reason, message }) => StoredJob.cases.Failure.make({ key, reason, message }),
			}),
		),
		forks: Arr.map(forks, (fork) => ({ ...fork, ran: ranOf(fork.jobKey) })),
	};
}

/**
 * A stored result with every value decoded by the definition's result schema. The values decode one after another:
 * it is work on the CPU, which more fibers would not speed up.
 */
export const typed: <A>(work: Work<never, A>, stored: Stored) => Effect.Effect<Outcome<A>, InvalidValue> = Effect.fn(
	"Swarm.typed",
)(function* <A>(work: Work<never, A>, stored: Stored) {
	const jobs = yield* Effect.forEach(
		stored.jobs,
		(job): Effect.Effect<JobOutcome<A>, InvalidValue> =>
			StoredJob.match(job, {
				Success: (success) => Effect.map(work.decodeResult(success.value), (value) => ({ ...success, value })),
				Failure: (failure) => Effect.succeed(failure),
			}),
		{ concurrency: 1 },
	);
	return {
		swarmId: stored.swarmId,
		ending: stored.ending,
		jobs,
		forks: Arr.map(stored.forks, (fork) => ({
			...fork,
			bytesWritten: Option.fromNullOr(fork.bytesWritten),
			ran: Option.fromNullOr(fork.ran),
		})),
	};
});
