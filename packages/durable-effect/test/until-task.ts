// Test helper: waits until a live task is in a state, as Pi's task graph shows it, so a test acts once Pi stored that
// state (a sleep armed on the test clock, a wait on another task). No polling and no clock.

import type { TaskGraph, TaskGraphState, TaskId } from "@earendil-works/pi-durable";
import { Effect, Filter, Option, Stream } from "effect";
import { type DurableError, Harness } from "../src/index.ts";

/**
 * The state of the first live task the task graph shows with `status` (task `id` when given), now or at a later
 * change. The graph ends only when the harness closes, which no test waits through.
 */
export function untilTask<S extends TaskGraphState["status"]>(
	status: S,
	id?: TaskId,
): Effect.Effect<Extract<TaskGraphState, { readonly status: S }>, DurableError, Harness.Harness> {
	const found = (graph: TaskGraph) =>
		Option.fromUndefinedOr(
			Object.values(graph.tasks).find(
				(task) => task.state.status === status && (id === undefined || task.id === id),
			),
		);
	return Effect.map(
		Stream.runHead(
			Stream.filterMap(
				Harness.taskGraph,
				Filter.fromPredicateOption((change) => found(change.value)),
			),
		),
		// A state whose status is `status` is that member of the union, which `find` cannot narrow to.
		(task) => Option.getOrThrow(task).state as Extract<TaskGraphState, { readonly status: S }>,
	);
}
