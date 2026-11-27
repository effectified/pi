// Job events: what a host that shows a swarm's progress watches, read from the statuses the coordinator stores.

import { type Doc, Harness } from "@effectified/pi-durable";
import { Array as Arr, Match, Option, Record, Schema, Stream } from "effect";
import { JobKey, type SwarmId } from "./ids.ts";
import { Reason, type Status } from "./job.ts";
import { Jobs, type Progress, type Statuses } from "./ledger.ts";

/** One step of one job: its fork was asked for, it settled with a result, or it failed. Choose with `JobEvent.match`. */
export const JobEvent = Schema.TaggedUnion({
	Started: { key: JobKey },
	Settled: { key: JobKey },
	Failed: { key: JobKey, reason: Reason },
});

/** One step of one job. */
export type JobEvent = typeof JobEvent.Type;

/**
 * The job events of a swarm, from the statuses its coordinator stores with every step. It starts with the events
 * that lead to the statuses of now, so a host that attaches late misses none, and ends once every job has settled or
 * the harness closes. It is a watch, not a log: Pi folds the commits a slow consumer misses, so a job's events may
 * arrive together, always in their order. No element for an id nothing was started under.
 */
export function events(swarmId: SwarmId): Stream.Stream<JobEvent, Doc.Failure, Harness.Harness> {
	return Harness.watchDoc(Jobs, swarmId).pipe(
		Stream.mapAccum(
			(): Statuses => ({}),
			(seen, change) => [change.value, [{ events: between(seen, change.value), last: allSettled(change.value) }]],
		),
		Stream.takeUntil((batch) => batch.last),
		Stream.flatMap((batch) => Stream.fromIterable(batch.events)),
	);
}

/** The events that lead from the statuses `seen` to the statuses `now`. A job never seen was planned. */
function between(seen: Statuses, now: Statuses): Array<JobEvent> {
	return Arr.flatMap(Record.toEntries(now), ([key, progress]) =>
		stepsOf(
			key,
			Option.match(Record.get(seen, key), { onNone: () => "planned", onSome: (was) => was.status }),
			progress,
		),
	);
}

/** The events of one job that was `before` and is now as `progress` says. */
function stepsOf(key: JobKey, before: Status, progress: Progress): Array<JobEvent> {
	if (before === progress.status) return [];
	const started = before === "planned" ? [JobEvent.cases.Started.make({ key })] : [];
	return Match.value(progress.status).pipe(
		Match.when("planned", (): Array<JobEvent> => []),
		Match.whenOr("starting", "running", () => started),
		Match.when("succeeded", () => [...started, JobEvent.cases.Settled.make({ key })]),
		// A failed job has a reason: the two are written together. Whether it ever started is not stored.
		Match.when("failed", () =>
			progress.reason === null ? [] : [JobEvent.cases.Failed.make({ key, reason: progress.reason })],
		),
		Match.exhaustive,
	);
}

function allSettled(statuses: Statuses): boolean {
	return Arr.every(Record.values(statuses), ({ status }) => status === "succeeded" || status === "failed");
}
