import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { HarnessInspection } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { type DurableError, Harness } from "../src/index.ts";
import { clockOptions } from "../src/timers.ts";
import { AGENT, answer, harnessLayer, scriptedModels } from "./scripted.ts";

/** Lets Pi's promises and timers of the real clock run while the test clock stands still. */
const realTick = TestClock.withLive(Effect.sleep("2 millis"));

describe("clockOptions", () => {
	it("reads the time from Effect's Clock and fires timers when the Clock reaches them", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { now, setTimer } = yield* clockOptions;
				yield* TestClock.setTime(1_000);
				const before = now();
				const fired: string[] = [];
				setTimer(() => fired.push("armed"), 500, { background: false });
				const disarm = setTimer(() => fired.push("disarmed"), 500, { background: true });
				disarm?.();
				yield* TestClock.adjust("499 millis");
				const early = [...fired];
				yield* TestClock.adjust("1 millis");
				return { before, early, fired, after: now() };
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(seen).toEqual({ before: 1_000, early: [], fired: ["armed"], after: 1_500 });
	});
});

describe("a harness on a TestClock", () => {
	it("waits out a retry backoff on the test clock, with no real waiting", async () => {
		const scripted = scriptedModels([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
			answer("Second try."),
		]);
		const started = performance.now();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go." });
				const backoff = yield* untilSleeping;
				const now = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()));
				// One millisecond before the backoff ends nothing has moved.
				yield* TestClock.adjust(backoff - now - 1);
				yield* realTick;
				const early = { calls: scripted.faux.state.callCount, status: (yield* submission.status).status };
				yield* TestClock.adjust(1);
				const settled = yield* submission.wait;
				return { delay: backoff - now, early, settled, calls: scripted.faux.state.callCount };
			}).pipe(Effect.provide(harnessLayer({ models: scripted.layer })), Effect.provide(TestClock.layer())),
		);
		// Pi's default retry policy waits baseDelayMs (2,000 ms) before the second attempt.
		expect(seen.delay).toBe(2_000);
		expect(seen.early).toEqual({ calls: 1, status: "placed" });
		expect(seen.settled.status).toBe("done");
		expect(seen.calls).toBe(2);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});

/** The deadline of the first sleeping task, once one sleeps: polls in real time, since the test clock stands still. */
const untilSleeping: Effect.Effect<number, DurableError, Harness.Harness> = Effect.flatMap(
	Harness.inspect,
	(inspection) => {
		const until = sleepingUntil(inspection);
		return until === undefined
			? Effect.andThen(
					realTick,
					Effect.suspend(() => untilSleeping),
				)
			: Effect.succeed(until);
	},
);

function sleepingUntil(inspection: HarnessInspection): number | undefined {
	for (const task of inspection.tasks) {
		if (task.state.kind === "sleeping") return task.state.until;
	}
	return undefined;
}
