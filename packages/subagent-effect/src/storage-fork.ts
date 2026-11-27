// A copied storage runs no subagent of the storage it was copied from: what a host runs on a copy of a whole harness
// storage before its first call.

import { type Doc, Harness, Task } from "@effectified/pi-durable";
import { Array as Arr, Effect, Option, Stream } from "effect";
import * as Copy from "./copy.ts";
import { LIVE } from "./live.ts";
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
			// Pi's rule for a commit: every table read comes before the first write. The runs with each status at work
			// are as many as there are subagents at work, whatever else the storage holds.
			const newest = yield* tx.scanTasks({ order: "descending" }, 1);
			const live = yield* Stream.runCollect(
				Stream.fromIterable(LIVE).pipe(
					Stream.flatMap((status) => tx.tasks({ kind: Run.NAME, status })),
					Stream.map((task) => task.id),
				),
			);
			const through = Option.getOrElse(
				Option.map(Arr.head(newest.items), (task) => task.id),
				() => Task.Id.make(0),
			);
			yield* Effect.flatMap(tx.doc(Copy.Document), (mark) => mark.set({ through }));
			return live;
		}),
	);
	// The abort ends a run that sleeps until its child's submission settles, and with it the child's own work. One at a
	// time: each abort is a commit, and Pi stores commits one at a time.
	yield* Effect.forEach(inherited, (taskId) => Harness.abortTask(taskId), { concurrency: 1, discard: true });
}).pipe(Effect.withSpan("Subagents.onStorageFork"));
