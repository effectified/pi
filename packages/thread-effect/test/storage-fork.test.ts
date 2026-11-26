// `StorageFork.onStorageFork` on one storage, which stands in for a copy of itself here. On a real copy, a fork of a
// thread actor, it is what keeps the pinned fork's thread at its own money (rivet-suite.ts).

import type { TaskId } from "@earendil-works/pi-durable";
import { Extension, Harness, Task } from "@effectified/pi-durable";
import { answer, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Option, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OutcomeCourier, OutcomeCursor, StorageFork, Threads } from "../src/index.ts";
import { outside, providers, run, work } from "./world.ts";

/** A task that ends at once: what stands for a swarm's coordinator here. */
const Noop = Task.make({
	name: "test.noop",
	version: 1,
	input: Schema.Null,
	state: Schema.Struct({ phase: Schema.Literal("run") }),
	result: Schema.Null,
	initial: () => ({ phase: "run" as const }),
	phases: { run: () => Effect.succeed(Task.complete(null)) },
	abort: () => Effect.succeed(Task.aborted()),
});

const started = Effect.flatMap(Harness.root, (root) =>
	root.commit((tx) => tx.createTask(Noop, null, { ownership: { kind: "conversation" }, background: true })),
);

describe("the composition's step on a copied storage", () => {
	it("marks the tasks the copy holds as inherited, and none that start afterwards", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const before = yield* started;
				const unmarked = (yield* StorageFork.inherited)(before);
				yield* StorageFork.onStorageFork;
				// Again, as a host that was cut off does: the same mark.
				yield* StorageFork.onStorageFork;
				const after = yield* started;
				const inherited = yield* StorageFork.inherited;
				return { unmarked, before: inherited(before), after: inherited(after), ordered: before < after };
			}).pipe(Effect.provide(TestHarness.layer({ extensions: [Extension.make({ name: "test", tasks: [Noop] })] }))),
		);
		expect(seen).toEqual({ unmarked: false, before: true, after: false, ordered: true });
	});

	it("inherits nothing in a storage that was never copied", async () => {
		const inherited = await Effect.runPromise(StorageFork.inherited.pipe(Effect.provide(TestHarness.layer())));
		expect(inherited(1 as TaskId)).toBe(false);
	});
});

describe("the outcome events of a copied storage", () => {
	it("are its source's to tell: the copied courier ends without a delivery, and the cursor says where the thread stands", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], reviewer: [answer('{"findings":[]}')] });
		// The sink refuses its first call, and the next attempt is an hour away: the thread ends with `Started` still
		// to be told and its courier asleep, which is how a copy can hold both.
		state.told.failing = 1;
		const cursor = Effect.map(Harness.snapshot(OutcomeCursor.Document, "t1"), Option.getOrThrow);
		const seen = await run(
			state,
			labs,
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.work(work("t1", "What is six times seven?")));
				let before = yield* cursor;
				while (before.retryAt === null) {
					yield* Effect.sleep("1 millis");
					before = yield* cursor;
				}
				yield* StorageFork.onStorageFork;
				// Again, as a host that was cut off does: the same cursor.
				const once = yield* cursor;
				yield* StorageFork.onStorageFork;
				const after = yield* cursor;
				// The copy's harness resumes its tasks: the courier it inherited runs once more.
				const courier = Option.getOrThrow(Option.fromNullOr(before.courier));
				yield* Harness.signal(courier, OutcomeCourier.Nudge, before.waiting ?? "", null);
				const ended = yield* Harness.waitForTask(courier);
				return { before, once, after, ended: ended.state.outcome, calls: state.told.calls };
			}),
			{ outcomes: { retry: Schedule.spaced("1 hour") } },
		);
		expect(seen.before).toMatchObject({ delivered: null, pending: { mark: { entry: 0, state: "Started" } } });
		// Everything up to where the thread stands counts as told, nothing is pending, and no courier is named.
		expect(seen.after).toMatchObject({
			delivered: { state: "Reviewed" },
			pending: null,
			courier: null,
			waiting: null,
			retryAt: null,
		});
		expect(seen.once).toEqual(seen.after);
		// The inherited courier ended as copied, and the sink was not called again: its one call is the refused one.
		expect(seen.ended).toMatchObject({ status: "aborted", reason: "copied" });
		expect(seen.calls).toBe(1);
		expect(state.told.events).toEqual([]);
	});
});
