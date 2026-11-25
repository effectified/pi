// The wake keeper without an engine: a harness on memory storage that leaves its wake-ups to the host, and a fake of
// the actor's schedule and keep-awake. The park below is 200 milliseconds of real time.

import { Extension, Gate, Harness, Hook, Tool } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, held, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Clock, Effect, Layer, Option, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as WakeKeeper from "../src/wake-keeper.ts";

const PARK_MILLIS = 200;

const Slow = Tool.make("slow", {
	description: "Answers after a while.",
	parameters: Schema.Struct({}),
	success: Schema.String,
	replay: "safe",
	handler: () => Effect.succeed("done"),
});

const Timed = Hook.beforeTool((_call, api) =>
	Effect.gen(function* () {
		const until = yield* api.memo("test.until", (yield* api.now) + PARK_MILLIS);
		return (yield* api.now) >= until ? Gate.allow : Gate.park({ until });
	}),
);

/** A fake of the actor's side: what is scheduled, and whether the actor is held awake. */
function fakeAlarm(left: ReadonlyArray<WakeKeeper.Armed> = []) {
	const scheduled = new Map(left.map((armed) => [armed.id, armed.at]));
	const state = { awake: false, refusing: false, written: 0 };
	const alarm: WakeKeeper.Alarm = {
		schedule: (at) =>
			Effect.suspend(() => {
				if (state.refusing) return Effect.fail("refused");
				const id = `wake-${state.written++}`;
				scheduled.set(id, at);
				return Effect.succeed(id);
			}),
		cancel: (id) => Effect.sync(() => void scheduled.delete(id)),
		scheduled: Effect.sync(() => [...scheduled].map(([id, at]) => ({ id, at }))),
		stayAwake: Effect.sync(() => {
			state.awake = true;
		}),
		letSleep: Effect.sync(() => {
			state.awake = false;
		}),
	};
	return { alarm, scheduled, state };
}

/** Runs `test` with a keeper over `alarm` on a fresh harness whose model answers with `responses`. */
const withKeeper = <A, E>(
	alarm: WakeKeeper.Alarm,
	responses: ReadonlyArray<FauxResponseStep>,
	test: Effect.Effect<A, E, WakeKeeper.WakeKeeper | TestHarness.Provided>,
): Promise<A> =>
	Effect.runPromise(
		Effect.provide(
			test,
			WakeKeeper.layer(alarm).pipe(
				Layer.provideMerge(
					TestHarness.layer({
						extensions: [Extension.make({ name: "test", tools: [Slow], hooks: [Timed] })],
						responses,
						harness: { hostWakes: true },
					}),
				),
			),
		),
	);

/** Succeeds once Pi has nothing that can run and nothing asleep: open's own recovery pass counts as work until then. */
const quiet = Effect.repeat(Harness.wake, { until: (wake) => !wake.active && wake.at === undefined });

describe("WakeKeeper.layer", () => {
	it("keeps no wake and lets the actor sleep while Pi has nothing to do", async () => {
		const fake = fakeAlarm();
		await withKeeper(
			fake.alarm,
			[],
			Effect.andThen(
				quiet,
				WakeKeeper.WakeKeeper.use((keeper) => keeper.settle),
			),
		);
		expect([...fake.scheduled]).toEqual([]);
		expect(fake.state.awake).toBe(false);
	});

	it("guards a call with a recovery wake, and drops it when the call started nothing", async () => {
		const fake = fakeAlarm();
		await withKeeper(
			fake.alarm,
			[],
			Effect.gen(function* () {
				const keeper = yield* WakeKeeper.WakeKeeper;
				yield* quiet;
				yield* keeper.settle;
				expect([...fake.scheduled]).toEqual([]);
				const before = yield* Clock.currentTimeMillis;
				yield* keeper.guard;
				const guarded = [...fake.scheduled.values()];
				expect(guarded).toHaveLength(1);
				expect(guarded[0]).toBeGreaterThanOrEqual(before + WakeKeeper.RECOVERY_WAKE_MILLIS);
				expect(guarded[0]).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) + WakeKeeper.RECOVERY_WAKE_MILLIS);
				expect(fake.state.awake).toBe(true);
				// A second guard finds the wake near enough and writes nothing.
				yield* keeper.guard;
				expect([...fake.scheduled.values()]).toEqual(guarded);
				yield* keeper.settle;
			}),
		);
		expect([...fake.scheduled]).toEqual([]);
		expect(fake.state.awake).toBe(false);
	});

	it("adopts the earliest wake an earlier wake of the actor left, and cancels the others", async () => {
		const far = Date.now() + 3_600_000;
		const fake = fakeAlarm([
			{ id: "left-later", at: far + 1 },
			{ id: "left-earliest", at: far },
		]);
		await withKeeper(
			fake.alarm,
			[],
			Effect.gen(function* () {
				expect(fake.scheduled.has("left-later")).toBe(false);
				// Nothing is left to wake for: the adopted wake goes too.
				yield* quiet;
				yield* (yield* WakeKeeper.WakeKeeper).settle;
			}),
		);
		expect([...fake.scheduled]).toEqual([]);
	});

	it("holds the actor awake while a run is active, keeps one wake at a park's time, and resumes when it fires", async () => {
		const fake = fakeAlarm();
		const first = held(toolCall("slow", {}, { id: "call-1" }));
		const settled = await withKeeper(
			fake.alarm,
			[first.response, answer("Done.")],
			Effect.gen(function* () {
				const keeper = yield* WakeKeeper.WakeKeeper;
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go slowly.", requestId: "run" });
				yield* first.requested;
				yield* keeper.settle;
				// The model is working: awake, with one recovery wake no later than the recovery time ahead.
				expect(fake.state.awake).toBe(true);
				expect([...fake.scheduled.values()]).toHaveLength(1);
				expect([...fake.scheduled.values()][0]).toBeLessThanOrEqual(
					(yield* Clock.currentTimeMillis) + WakeKeeper.RECOVERY_WAKE_MILLIS,
				);

				yield* first.release;
				const parked = yield* Effect.repeat(Harness.wake, {
					until: (wake) => !wake.active && wake.at !== undefined,
				});
				yield* keeper.settle;
				// The call is parked: one wake, at the park's time, and the actor may sleep.
				expect([...fake.scheduled.values()]).toEqual([parked.at]);
				expect(fake.state.awake).toBe(false);

				// Pi arms no timer of its own: without the fired wake the run stays parked past its time.
				yield* Effect.sleep(PARK_MILLIS + 100);
				expect((yield* submission.status).status).not.toBe("done");
				const [id] = [...fake.scheduled.keys()];
				// Rivet removes a schedule before it runs its action.
				fake.scheduled.delete(id ?? "");
				yield* keeper.fired(Option.fromUndefinedOr(id));
				const record = yield* submission.wait;
				yield* quiet;
				yield* keeper.settle;
				return record.status;
			}),
		);
		expect(settled).toBe("done");
		expect([...fake.scheduled]).toEqual([]);
		expect(fake.state.awake).toBe(false);
	});

	it("resumes work whose wake is past at the next call, without waiting for the wake's action", async () => {
		const fake = fakeAlarm();
		const first = held(toolCall("slow", {}, { id: "call-1" }));
		const settled = await withKeeper(
			fake.alarm,
			[first.response, answer("Done.")],
			Effect.gen(function* () {
				const keeper = yield* WakeKeeper.WakeKeeper;
				const root = yield* TestHarness.root;
				const submission = yield* root.submit({ type: "input", content: "Go slowly.", requestId: "run" });
				yield* first.requested;
				yield* first.release;
				yield* Effect.repeat(Harness.wake, { until: (wake) => !wake.active && wake.at !== undefined });
				yield* keeper.settle;
				const [parked] = [...fake.scheduled.keys()];
				// The park's time passes and Rivet has not run the wake's action yet. A caller asks the actor meanwhile, as
				// one that polls does: the call's guard and settle. The fake never runs an action, so only they can resume.
				yield* Effect.sleep(PARK_MILLIS + 100);
				yield* keeper.guard;
				yield* keeper.settle;
				// Asked, never waited for: waiting for a submission would itself carry it on.
				const ended = yield* submission.status.pipe(
					Effect.repeat({ until: (record) => record.status === "done", schedule: Schedule.spaced("20 millis") }),
					Effect.timeoutOption("3 seconds"),
				);
				// The wake that was due is gone, not pushed back by the recovery time.
				expect(fake.scheduled.has(parked ?? "")).toBe(false);
				yield* quiet;
				yield* keeper.settle;
				return Option.map(ended, (record) => record.status);
			}),
		);
		expect(settled).toEqual(Option.some("done"));
		expect([...fake.scheduled]).toEqual([]);
		expect(fake.state.awake).toBe(false);
	});

	it("holds the actor awake when a wake cannot be written", async () => {
		const fake = fakeAlarm();
		fake.state.refusing = true;
		await withKeeper(
			fake.alarm,
			[],
			Effect.gen(function* () {
				const keeper = yield* WakeKeeper.WakeKeeper;
				yield* quiet;
				yield* keeper.guard;
				expect([...fake.scheduled]).toEqual([]);
				expect(fake.state.awake).toBe(true);
				yield* keeper.settle;
				// Nothing needed the wake after all, so nothing holds the actor.
				expect(fake.state.awake).toBe(false);
			}),
		);
	});
});
