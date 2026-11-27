// Clean-up: every fork of a swarm that no pin keeps is destroyed through the driver, and what became of each is kept.

import { Array as Arr, Effect, Option, Schema } from "effect";
import { Bytes, type Fork, type ForkDriverService, type ForkRetryLater } from "./driver.ts";
import { ForkId, JobKey, type SwarmId } from "./ids.ts";
import { isPlanned, type Job } from "./job.ts";
import type { Disposed } from "./outcome.ts";

/** One fork during clean-up: `pending` until the driver destroyed it; a pinned one is kept from the start. */
export const Disposal = Schema.Struct({
	jobKey: JobKey,
	forkId: ForkId,
	fate: Schema.Literals(["pending", "destroyed", "pinned"]),
	bytesWritten: Schema.NullOr(Bytes),
});

/** One fork during clean-up. */
export type Disposal = typeof Disposal.Type;

/** What to do with each of `forks`: a fork of a pinned job is kept, every other one is to be destroyed. */
export function plan(forks: ReadonlyArray<Fork>, pins: ReadonlyArray<JobKey>): Array<Disposal> {
	return Arr.map(forks, (fork) => ({
		jobKey: fork.jobKey,
		forkId: fork.forkId,
		fate: Arr.contains(pins, fork.jobKey) ? "pinned" : "pending",
		bytesWritten: null,
	}));
}

/** The forks the jobs themselves name: what clean-up works from when the driver cannot list. */
export function named(swarmId: SwarmId, keys: ReadonlyArray<JobKey>, jobs: ReadonlyArray<Job>): Array<Fork> {
	return Arr.flatMap(Arr.zip(keys, jobs), ([jobKey, job]) =>
		isPlanned(job) || job.fork === null ? [] : [{ swarmId, jobKey, forkId: job.fork }],
	);
}

/** What one pass made of the forks, and the "retry later" of every fork that is still pending. */
export interface Passed {
	readonly disposals: Array<Disposal>;
	/** One per pending fork, each with its own hint: the next pass waits for all of them. Empty when none is pending. */
	readonly retries: Array<ForkRetryLater>;
}

/** One pass: destroys every pending fork, `concurrency` at a time. A "retry later" leaves its fork pending. */
export const pass = Effect.fn("Swarm.cleanUp")(function* (
	driver: ForkDriverService,
	swarmId: SwarmId,
	disposals: ReadonlyArray<Disposal>,
	concurrency: number,
) {
	const tried = yield* Effect.forEach(disposals, (disposal) => destroyed(driver, swarmId, disposal), { concurrency });
	return {
		disposals: Arr.map(tried, ({ disposal }) => disposal),
		retries: Arr.getSomes(Arr.map(tried, ({ retry }) => retry)),
	};
});

/** One fork after its destroy call: destroyed with what it wrote, or still pending with the driver's "retry later". */
interface Tried {
	readonly disposal: Disposal;
	readonly retry: Option.Option<ForkRetryLater>;
}

/** Destroys one fork that is pending; a fork destroyed or pinned already is left as it is. */
function destroyed(driver: ForkDriverService, swarmId: SwarmId, disposal: Disposal): Effect.Effect<Tried> {
	if (disposal.fate !== "pending") return Effect.succeed({ disposal, retry: Option.none() });
	return Effect.match(driver.destroy({ swarmId, jobKey: disposal.jobKey, forkId: disposal.forkId }), {
		onFailure: (error) => ({ disposal, retry: Option.some(error) }),
		onSuccess: ({ bytesWritten }) => ({
			disposal: { ...disposal, fate: "destroyed", bytesWritten: Option.getOrNull(bytesWritten) },
			retry: Option.none(),
		}),
	});
}

/** What became of each fork when the swarm ends: one that is still pending was left to the driver's list. */
export function fates(disposals: ReadonlyArray<Disposal>): Array<Disposed> {
	return Arr.map(disposals, (disposal) => ({
		...disposal,
		fate: disposal.fate === "pending" ? "left" : disposal.fate,
	}));
}
