// A copied storage runs no subagent of the storage it was copied from: what a host runs on a copy of a whole harness
// storage before its first call.

import type { Cursor, TaskId } from "@earendil-works/pi-durable";
import { type Doc, Harness, type Tx } from "@gunta/pi-durable-effect";
import { Effect } from "effect";
import * as Copy from "./copy.ts";
import * as Run from "./run.ts";

/**
 * Ends every subagent run the copy inherited live, foreground and background alike. Run it on a storage copied from
 * another one (an actor fork), on a harness opened with `resume: false`, before anything else.
 *
 * Why: a copy of a storage holds a copy of every run task. Left alone, a run that was live at the copy starts its
 * phase again there: it gives its child the task a second time, or sends the child's result to the copied parent,
 * where it starts a turn, while the storage it was copied from does the same. Marked and aborted, a copied run ends
 * `aborted` with the reason `copied` once the harness resumes:
 *
 * - it sends no provider request: Pi ends the work the run owns, its child's, before the run's own end, and a
 *   request of the child that the copy holds in flight is not sent again;
 * - it admits no report into the parent's conversation, and asks the product's `ChildSetup` nothing;
 * - its `subagent.child` document reads `Failed` with the reason `copied`, which `subagent_status` and a waiting
 *   `subagent` call give the parent's model as an error result.
 *
 * A child that had ended before the copy keeps its document and its result. Subagents started on the copy afterwards
 * run as usual: their tasks are newer than the mark. Idempotent before the copy's first call: a second run writes
 * the same mark and marks the same tasks.
 */
export const onStorageFork: Effect.Effect<void, Doc.Failure, Harness.Harness> = Effect.gen(function* () {
	const inherited = yield* Harness.commit((tx) =>
		Effect.gen(function* () {
			// Pi's rule for a commit: every table read comes before the first write.
			const newest = yield* tx.scanTasks({ order: "descending" }, 1);
			const live = (yield* Effect.forEach(LIVE, (status) => runsIn(tx, status))).flat();
			yield* Effect.flatMap(tx.doc(Copy.Document), (mark) => mark.set({ through: newest.items[0]?.id ?? 0 }));
			return live;
		}),
	);
	// The abort ends a run that sleeps until its child's submission settles, and with it the child's own work.
	yield* Effect.forEach(inherited, (taskId) => Harness.abortTask(taskId), { discard: true });
});

/** The statuses of a task that has not ended: Pi's scan filters by one status. */
const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;

const PAGE_SIZE = 100;

/** The runs with `status`, which are as many as there are subagents at work, whatever else the storage holds. */
function runsIn(tx: Tx.Tx, status: (typeof LIVE)[number]): Effect.Effect<ReadonlyArray<TaskId>, Doc.Failure> {
	return Effect.gen(function* () {
		const found: Array<TaskId> = [];
		let next: Cursor | undefined;
		do {
			const page = yield* tx.scanTasks({ kind: Run.NAME, status }, PAGE_SIZE, next);
			found.push(...page.items.map((task) => task.id));
			next = page.next;
		} while (next !== undefined);
		return found;
	});
}
