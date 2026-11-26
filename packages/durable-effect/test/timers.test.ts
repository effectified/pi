import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Harness } from "../src/index.ts";
import { clockOptions } from "../src/timers.ts";
import { AGENT, answer, harnessLayer, scriptedModels } from "./scripted.ts";
import { untilTask } from "./until-task.ts";

describe("clockOptions", () => {
	it("reads the time from Effect's Clock and fires timers when the Clock reaches them", async () => {
		const seen = await runTest(
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
			}),
		);
		expect(seen).toEqual({ before: 1_000, early: [], fired: ["armed"], after: 1_500 });
	});

	it("never fires a timer left armed once the scope that made the options closed", async () => {
		const fired = await runTest(
			Effect.gen(function* () {
				const fired: string[] = [];
				yield* Effect.scoped(
					Effect.map(clockOptions, ({ setTimer }) => {
						setTimer(() => fired.push("foreground"), 500, { background: false });
						setTimer(() => fired.push("background"), 500, { background: true });
					}),
				);
				yield* TestClock.adjust("1 second");
				return fired;
			}),
		);
		expect(fired).toEqual([]);
	});
});

describe("a harness on a TestClock", () => {
	it("waits out a retry backoff on the test clock, with no real waiting", async () => {
		const scripted = scriptedModels([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
			answer("Second try."),
		]);
		const started = performance.now();
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go." });
				// A retry backoff sleeps until a deadline.
				const backoff = Option.getOrThrow(Option.fromUndefinedOr((yield* untilTask("sleeping")).until));
				const now = yield* Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()));
				// One millisecond before the backoff ends nothing has moved, once Pi had a turn to move it.
				yield* TestClock.adjust(backoff - now - 1);
				yield* Effect.yieldNow;
				const early = { calls: scripted.faux.state.callCount, status: (yield* submission.status).status };
				yield* TestClock.adjust(1);
				const settled = yield* submission.wait;
				return { delay: backoff - now, early, settled, calls: scripted.faux.state.callCount };
			}).pipe(Effect.provide(harnessLayer({ models: scripted.layer }))),
		);
		// Pi's default retry policy waits baseDelayMs (2,000 ms) before the second attempt.
		expect(seen.delay).toBe(2_000);
		expect(seen.early).toEqual({ calls: 1, status: "placed" });
		expect(seen.settled.status).toBe("done");
		expect(seen.calls).toBe(2);
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
