// A copied storage holds no swarm of its own: what a host runs on a copy of a whole harness storage before its first call.

import type { TaskId } from "@effectified/pi-durable";
import { type Doc, Harness } from "@effectified/pi-durable";
import { Effect, Stream } from "effect";
import { TASK_PREFIX } from "./coordinator.ts";
import { Copy } from "./ledger.ts";

/**
 * Makes every coordinator the copy inherited do nothing, and aborts those still live. Run it on a storage copied
 * from another one (an actor fork), on a harness opened with `resume: false`, before anything else.
 *
 * Why: a copy of a storage holds a copy of every coordinator task. Left alone, the copy would run the swarm a second
 * time against the same driver, and its cancel would destroy the forks of the storage it was copied from. Marked,
 * a copied coordinator ends `aborted` with the reason `copied` and asks the driver nothing. Swarms started on the
 * copy afterwards run as usual: their tasks are newer than the mark.
 */
export const onStorageFork: Effect.Effect<void, Doc.Failure, Harness.Harness> = Effect.gen(function* () {
	const inherited = yield* Harness.commit((tx) =>
		Effect.gen(function* () {
			// Pi's rule for a commit: every table read comes before the first write.
			const newest = yield* tx.scanTasks({ order: "descending" }, 1);
			// Coordinators are background tasks, so this reads few records, whatever the storage holds.
			const live: ReadonlyArray<TaskId> = yield* Stream.runCollect(
				tx.tasks({ background: true }).pipe(
					Stream.filter((task) => task.kind.startsWith(TASK_PREFIX) && task.state.status !== "terminal"),
					Stream.map((task) => task.id),
				),
			);
			yield* Effect.flatMap(tx.doc(Copy), (copy) => copy.set({ through: newest.items[0]?.id ?? 0 }));
			return live;
		}),
	);
	// An abort wakes a coordinator that sleeps on a signal the copy will never get; it then ends as marked.
	yield* Effect.forEach(inherited, (taskId) => Harness.abortTask(taskId), { discard: true });
});
