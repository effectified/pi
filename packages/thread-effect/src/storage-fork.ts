// A copied storage counts no swarm of the storage it was copied from, and tells of none of its outcomes: the
// composition's own step on a copy of a whole harness storage, beside the plugins'.

import type { TaskId } from "@effectified/pi-durable";
import { Doc, Harness } from "@effectified/pi-durable";
import { Effect, Option, Schema, Stream } from "effect";
import * as Courier from "./outcome-courier.ts";
import * as Cursor from "./outcome-cursor.ts";
import type { Mark } from "./outcome-event.ts";
import * as Standing from "./standing.ts";
import * as Thread from "./thread.ts";

/**
 * Marks what the copy inherited as its source's, in one commit. Run it on a storage copied from another one (an
 * actor fork), on a harness opened with `resume: false`, before its first call.
 *
 * - **Swarms.** A thread's document is copied with the ids of the swarms started on it, and so are their accounts.
 *   Left alone, the copy would add the money of its source's forks to its own thread, and ask those forks for it.
 *   Marked, it counts only the swarms started on it afterwards, whose coordinators are newer than the mark
 *   (`inherited`).
 * - **Outcomes.** A thread is copied with its delivery cursor, maybe with an event its source has not delivered yet,
 *   and with its courier. The source delivers what the thread reached there. In the copy the courier ends as copied
 *   (the same mark), no event is pending, and the cursor says that everything up to where the thread stands is
 *   delivered: a thread that is taken on in the copy tells of what it does there, and of nothing before.
 *
 * Idempotent before the copy's first call: a second run writes the same.
 */
export const onStorageFork: Effect.Effect<void, Doc.Failure, Harness.Harness> = Effect.gen(function* () {
	// Where every copied thread stands, read before the commit: a commit reads only through its transaction.
	const couriers = yield* Stream.runCollect(Harness.scanTasks({ kind: Courier.task.name }));
	const threads = new Set(couriers.flatMap((courier) => Option.toArray(decodeInput(courier.input))).map(threadOf));
	const reached = yield* Effect.forEach([...threads], (thread) =>
		Effect.map(standingOf(thread), (mark) => ({ thread, mark })),
	);
	yield* Harness.commit((tx) =>
		Effect.gen(function* () {
			// Pi's rule for a commit: every table read comes before the first write.
			const newest = yield* tx.scanTasks({ order: "descending" }, 1);
			yield* Effect.flatMap(tx.doc(Copy), (mark) => mark.set({ through: newest.items[0]?.id ?? 0 }));
			for (const { thread, mark } of reached) {
				const cursor = yield* tx.doc(Cursor.Document, thread, null);
				const held = yield* cursor.get;
				const delivered = Option.getOrElse(mark, () => held.delivered);
				yield* cursor.set({ ...held, delivered, pending: null, courier: null, waiting: null, retryAt: null });
			}
		}),
	);
});

// Stored input: a courier's own, as Pi kept it.
const decodeInput = Schema.decodeUnknownOption(Courier.Input);

function threadOf(input: typeof Courier.Input.Type): string {
	return input.thread;
}

/**
 * The mark of the newest event of the thread as it stands, resting on the newest entry: after it nothing is due until
 * the thread moves, and no wait of its review stored before the copy is told. A `Started` mark's id has no entry, so
 * it rests there too. None for a thread without a submission, and for a key whose thread document the copy does not
 * hold.
 */
function standingOf(thread: string): Effect.Effect<Option.Option<Mark>, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const conversation = yield* Thread.conversation(thread);
		const sight = yield* Standing.sight(thread, conversation);
		if (Option.isNone(sight)) return Option.none<Mark>();
		const submission = sight.value.record.id;
		const entry = Option.getOrElse(yield* conversation.head, () => 0);
		const state = Option.match(sight.value.ending, {
			onNone: () => "Started" as const,
			onSome: (ending) => ending._tag,
		});
		return Option.some<Mark>({ submission, entry, state });
	}).pipe(Effect.catchTag("ThreadNotFound", () => Effect.succeedNone));
}

/**
 * Written on a storage that was copied from another one, kind `thread.copy`: the tasks with an id up to `through`
 * were copied with it. A swarm whose coordinator is one of them is its source's, and so are its forks' money; a
 * courier that is one of them ends without delivering.
 */
const Copy = Doc.make({
	kind: "thread.copy",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ through: Schema.Number }),
	initial: () => ({ through: 0 }),
	// One number, written once per copy.
	checkpointWhen: () => true,
});

/**
 * Answers, for a task, whether it was copied with this storage: the coordinator of a swarm, which then belongs to
 * the storage this one was copied from, or a courier. One committed read, for any number of tasks.
 */
export const inherited: Effect.Effect<(task: TaskId) => boolean, Doc.Failure, Harness.Harness> = Effect.map(
	Harness.snapshot(Copy),
	(mark) => (task) => Option.isSome(mark) && task <= mark.value.through,
);
