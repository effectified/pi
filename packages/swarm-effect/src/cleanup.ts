// Clean-up: every fork of a swarm that no pin keeps is destroyed through the driver, and what became of each is kept.

import { Effect, Option, Schema } from "effect";
import type { Fork, ForkDriverService, ForkRetryLater } from "./driver.ts";
import type { Job } from "./job.ts";
import type { Disposed } from "./outcome.ts";

/** One fork during clean-up: `pending` until the driver destroyed it; a pinned one is kept from the start. */
export const Disposal = Schema.Struct({
	jobKey: Schema.String,
	forkId: Schema.String,
	fate: Schema.Literals(["pending", "destroyed", "pinned"]),
	bytesWritten: Schema.NullOr(Schema.Number),
});

/** One fork during clean-up. */
export type Disposal = typeof Disposal.Type;

/** What to do with each of `forks`: a fork of a pinned job is kept, every other one is to be destroyed. */
export function plan(forks: ReadonlyArray<Fork>, pins: ReadonlyArray<string>): Array<Disposal> {
	return forks.map((fork) => ({
		jobKey: fork.jobKey,
		forkId: fork.forkId,
		fate: pins.includes(fork.jobKey) ? "pinned" : "pending",
		bytesWritten: null,
	}));
}

/** The forks the jobs themselves name: what clean-up works from when the driver cannot list. */
export function named(swarmId: string, keys: ReadonlyArray<string>, jobs: ReadonlyArray<Job>): Array<Fork> {
	return jobs.flatMap((job, index) =>
		job.status === "planned" || job.fork === null ? [] : [{ swarmId, jobKey: keys[index], forkId: job.fork }],
	);
}

/** What one pass made of the forks, and the last "retry later" when some are still pending. */
export interface Passed {
	readonly disposals: Array<Disposal>;
	readonly retry: Option.Option<ForkRetryLater>;
}

/** One pass: destroys every pending fork, `concurrency` at a time. A "retry later" leaves its fork pending. */
export function pass(
	driver: ForkDriverService,
	swarmId: string,
	disposals: ReadonlyArray<Disposal>,
	concurrency: number,
): Effect.Effect<Passed> {
	return Effect.suspend(() => {
		// Written by the pass below as its calls fail: which one fails last does not matter, only that one did.
		let retry = Option.none<ForkRetryLater>();
		const destroy = (disposal: Disposal): Effect.Effect<Disposal> =>
			disposal.fate !== "pending"
				? Effect.succeed(disposal)
				: Effect.match(driver.destroy({ swarmId, jobKey: disposal.jobKey, forkId: disposal.forkId }), {
						onFailure: (error) => {
							retry = Option.some(error);
							return disposal;
						},
						onSuccess: (destroyed) => ({
							...disposal,
							fate: "destroyed",
							bytesWritten: Option.getOrNull(destroyed.bytesWritten),
						}),
					});
		return Effect.map(Effect.forEach(disposals, destroy, { concurrency }), (passed) => ({
			disposals: passed,
			retry,
		}));
	});
}

/** What became of each fork when the swarm ends: one that is still pending was left to the driver's list. */
export function fates(disposals: ReadonlyArray<Disposal>): Array<Disposed> {
	return disposals.map((disposal) => ({ ...disposal, fate: disposal.fate === "pending" ? "left" : disposal.fate }));
}
