// Job events: what a host that shows a swarm's progress watches, read from the statuses the coordinator stores.

import { type Doc, Harness } from "@effectified/pi-durable";
import { Stream } from "effect";
import type { Reason, Status } from "./job.ts";
import { Jobs, type Progress } from "./ledger.ts";

/** One step of one job: its fork was asked for, it settled with a result, or it failed. */
export type JobEvent =
	| { readonly _tag: "Started"; readonly key: string }
	| { readonly _tag: "Settled"; readonly key: string }
	| { readonly _tag: "Failed"; readonly key: string; readonly reason: Reason };

/**
 * The job events of a swarm, from the statuses its coordinator stores with every step. It starts with the events
 * that lead to the statuses of now, so a host that attaches late misses none, and ends once every job has settled or
 * the harness closes. It is a watch, not a log: Pi folds the commits a slow consumer misses, so a job's events may
 * arrive together, always in their order. No element for an id nothing was started under.
 */
export function events(swarmId: string): Stream.Stream<JobEvent, Doc.Failure, Harness.Harness> {
	return Harness.watchDoc(Jobs, swarmId).pipe(
		Stream.mapAccum(
			(): Readonly<Record<string, Progress>> => ({}),
			(seen, change) => [change.value, [{ events: between(seen, change.value), last: allSettled(change.value) }]],
		),
		Stream.takeUntil((batch) => batch.last),
		Stream.flatMap((batch) => Stream.fromIterable(batch.events)),
	);
}

/** The events that lead from the statuses `seen` to the statuses `now`. A job never seen was planned. */
function between(seen: Readonly<Record<string, Progress>>, now: Readonly<Record<string, Progress>>): Array<JobEvent> {
	return Object.entries(now).flatMap(([key, progress]) =>
		stepsOf(key, Object.hasOwn(seen, key) ? seen[key].status : "planned", progress),
	);
}

/** The events of one job that was `before` and is now as `progress` says. */
function stepsOf(key: string, before: Status, progress: Progress): Array<JobEvent> {
	if (before === progress.status) return [];
	const started: Array<JobEvent> = before === "planned" ? [{ _tag: "Started", key }] : [];
	switch (progress.status) {
		case "planned":
			return [];
		case "starting":
		case "running":
			return started;
		case "succeeded":
			return [...started, { _tag: "Settled", key }];
		case "failed":
			// A failed job has a reason: the two are written together. Whether it ever started is not stored.
			return progress.reason === null ? [] : [{ _tag: "Failed", key, reason: progress.reason }];
	}
}

function allSettled(statuses: Readonly<Record<string, Progress>>): boolean {
	return Object.values(statuses).every(({ status }) => status === "succeeded" || status === "failed");
}
