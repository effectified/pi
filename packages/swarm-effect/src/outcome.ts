// The result of a swarm: per job a success or a failure, in job order, and what became of every fork.

import { Effect, Option, Schema } from "effect";
import { Place } from "./driver.ts";
import type { InvalidValue } from "./errors.ts";
import { type Settled as Job, Reason } from "./job.ts";
import type { Work } from "./work.ts";

/** What became of one fork when the swarm ended, as stored. */
export const Fate = Schema.Struct({
	jobKey: Schema.String,
	forkId: Schema.String,
	/** `destroyed` through the driver; `pinned`, so kept; `left`, because the driver could not destroy it. */
	fate: Schema.Literals(["destroyed", "pinned", "left"]),
	/** The bytes the fork wrote, when it was destroyed and the driver knew them. */
	bytesWritten: Schema.NullOr(Schema.Number),
	/** Where the fork's job ran, when its driver said so: the conversation, and the actor for a fork that is one. */
	ran: Schema.NullOr(Place),
});

/** What clean-up knows of one fork: everything of its fate but where its job ran, which the job's state holds. */
export type Disposed = Omit<typeof Fate.Type, "ran">;

/** One job's result as stored: `value` is the result as its schema encodes it. */
export const StoredJob = Schema.Union([
	Schema.TaggedStruct("Success", { key: Schema.String, value: Schema.Json }),
	Schema.TaggedStruct("Failure", { key: Schema.String, reason: Reason, message: Schema.String }),
]);

/** How a swarm ended: every job was run, a job failed under `onFailure: "fail"`, or the swarm was cancelled. */
export const Ending = Schema.Literals(["completed", "failed", "cancelled"]);

/** How a swarm ended. */
export type Ending = typeof Ending.Type;

/** A swarm's result as the coordinator task stores it: the task's result, with results as stored JSON. */
export const Stored = Schema.Struct({
	swarmId: Schema.String,
	ending: Ending,
	jobs: Schema.Array(StoredJob),
	forks: Schema.Array(Fate),
});

/** A swarm's result as stored. */
export type Stored = typeof Stored.Type;

/** One job's result: the typed value, or why there is none. */
export type JobOutcome<A> =
	| { readonly _tag: "Success"; readonly key: string; readonly value: A }
	| { readonly _tag: "Failure"; readonly key: string; readonly reason: Reason; readonly message: string };

/** What became of one fork when the swarm ended. */
export interface Cleaned {
	readonly jobKey: string;
	readonly forkId: string;
	readonly fate: "destroyed" | "pinned" | "left";
	readonly bytesWritten: Option.Option<number>;
	/**
	 * Where the fork's job ran, when its driver said so: the conversation in the fork's harness storage, and the actor
	 * that holds that storage for a fork that is an actor. It is how a host attributes a fork's spend and records to
	 * its swarm. None for a fork whose job never got a request accepted.
	 */
	readonly ran: Option.Option<Place>;
}

/** A swarm's result: its jobs in the order of the plan, each with its typed value or its failure, and its forks. */
export interface Outcome<A> {
	readonly swarmId: string;
	readonly ending: Ending;
	readonly jobs: ReadonlyArray<JobOutcome<A>>;
	readonly forks: ReadonlyArray<Cleaned>;
}

/**
 * The stored result of a swarm whose jobs, in the order of `keys`, have all settled. Each fork is given the place its
 * job ran in, from the job of its key.
 */
export function of(
	swarmId: string,
	ending: Ending,
	keys: ReadonlyArray<string>,
	jobs: ReadonlyArray<Job>,
	forks: ReadonlyArray<Disposed>,
): Stored {
	return {
		swarmId,
		ending,
		jobs: jobs.map((job, index) => {
			const key = keys[index];
			return job.status === "succeeded"
				? { _tag: "Success", key, value: job.value }
				: { _tag: "Failure", key, reason: job.reason, message: job.message };
		}),
		forks: forks.map((fork) => ({ ...fork, ran: jobs[keys.indexOf(fork.jobKey)]?.ran ?? null })),
	};
}

/** A stored result with every value decoded by the definition's result schema. */
export function typed<A>(work: Work<never, A>, stored: Stored): Effect.Effect<Outcome<A>, InvalidValue> {
	return Effect.map(
		Effect.forEach(
			stored.jobs,
			(job): Effect.Effect<JobOutcome<A>, InvalidValue> =>
				job._tag === "Failure"
					? Effect.succeed(job)
					: Effect.map(work.decodeResult(job.value), (value) => ({ _tag: "Success", key: job.key, value })),
		),
		(jobs) => ({
			swarmId: stored.swarmId,
			ending: stored.ending,
			jobs,
			forks: stored.forks.map((fork) => ({
				...fork,
				bytesWritten: Option.fromNullOr(fork.bytesWritten),
				ran: Option.fromNullOr(fork.ran),
			})),
		}),
	);
}
