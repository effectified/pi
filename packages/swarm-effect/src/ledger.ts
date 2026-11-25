// What a swarm keeps in the harness storage beside its coordinator task: its task by swarm id, and its jobs' statuses.

import { Doc, type DurableError, type SchemaDecodeError, type Tx } from "@gunta/pi-durable-effect";
import { Effect, Schema } from "effect";
import { Place } from "./driver.ts";
import { type Job, Reason, ranOf, Status } from "./job.ts";

/** A complete copy of a document is stored after this many changes, which bounds what a reopen replays. */
const CHECKPOINT_EVERY = 64;

/**
 * One document per swarm id: the coordinator's task, which is how a swarm id finds its swarm again, and what
 * `destroyFork` released. Session scope: a swarm id names one swarm of the whole storage.
 */
export const Swarms = Doc.family({
	kind: "swarm.swarm",
	version: 1,
	scope: "session",
	schema: Schema.Struct({
		/** The definition's name; empty until `start` stored the swarm. */
		name: Schema.String,
		taskId: Schema.NullOr(Schema.Number),
		/** Per job key whose fork `destroyFork` destroyed: the bytes it wrote, when the driver knew them. */
		released: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
	}),
	initial: () => ({ name: "", taskId: null, released: {} }),
	checkpointWhen: () => false,
});

/** What is known of one job from outside the coordinator: its status, why it failed, and where it runs or ran. */
export const Progress = Schema.Struct({
	status: Status,
	reason: Schema.NullOr(Reason),
	ran: Schema.NullOr(Place),
});

/** What is known of one job from outside the coordinator. */
export type Progress = typeof Progress.Type;

/**
 * One document per swarm id: every job's status under its key, written by the coordinator in the commit that stores
 * the state it comes from. It is what `status` reads and the job events watch.
 */
export const Jobs = Doc.family({
	kind: "swarm.jobs",
	version: 1,
	scope: "session",
	schema: Schema.Record(Schema.String, Progress),
	initial: () => ({}),
	checkpointWhen: (_stored, _ops, info) => info.deltasSinceBase >= CHECKPOINT_EVERY,
});

/**
 * Written once on a storage that was copied from another one (`onStorageFork`): coordinators with a task id up to
 * `through` were copied with it. They belong to the storage they were copied from, and do nothing here.
 */
export const Copy = Doc.make({
	kind: "swarm.copy",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ through: Schema.Number }),
	initial: () => ({ through: 0 }),
	checkpointWhen: () => false,
});

/** What the job events and `status` are told of a job in this state. */
export function progressOf(job: Job): Progress {
	return { status: job.status, reason: job.status === "failed" ? job.reason : null, ran: ranOf(job) };
}

/**
 * Writes the jobs whose status differs between `before` and `after` to the swarm's `Jobs` document, in the commit of
 * `tx`: one field per changed job, so the stored change does not grow with the swarm.
 */
export function report(
	tx: Tx.Tx,
	swarmId: string,
	keys: ReadonlyArray<string>,
	before: ReadonlyArray<Job>,
	after: ReadonlyArray<Job>,
): Effect.Effect<void, DurableError | SchemaDecodeError> {
	const changed = after.flatMap((job, index): Array<readonly [string, Progress]> => {
		return before[index].status === job.status ? [] : [[keys[index], progressOf(job)]];
	});
	if (changed.length === 0) return Effect.void;
	return Effect.flatMap(tx.doc(Jobs, swarmId, null), (jobs) =>
		jobs.update((current) => ({ ...current, ...Object.fromEntries(changed) })),
	);
}
