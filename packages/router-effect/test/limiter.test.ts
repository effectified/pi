import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Limiter, type LimiterOptions } from "../src/index.ts";

/** Runs `program` with a fresh limiter on a test clock that starts at 0. */
function withLimiter<A>(options: LimiterOptions, program: Effect.Effect<A, never, Limiter>): Promise<A> {
	return Effect.runPromise(program.pipe(Effect.provide(Limiter.layer(options)), Effect.provide(TestClock.layer())));
}

/** Work that takes ten milliseconds of Clock time, and the most of it that ever ran at once. */
function gauge() {
	const seen = { inFlight: 0, max: 0, done: 0 };
	const work = Effect.gen(function* () {
		seen.inFlight += 1;
		seen.max = Math.max(seen.max, seen.inFlight);
		yield* Effect.sleep("10 millis");
		seen.inFlight -= 1;
		seen.done += 1;
	});
	return { seen, work };
}

describe("Limiter.withPermit", () => {
	it("runs at most maxInFlight effects of a key at once", async () => {
		const { seen, work } = gauge();
		const steps = await withLimiter(
			{ limits: { k: { maxInFlight: 2 } } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const fibers = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
					Effect.forkChild(limiter.withPermit("k", work)),
				);
				const steps: number[] = [];
				for (let step = 0; step < 3; step++) {
					yield* TestClock.adjust("10 millis");
					steps.push(seen.done);
				}
				yield* Effect.forEach(fibers, Fiber.join);
				return steps;
			}),
		);
		expect(seen.max).toBe(2);
		// Two finish every ten milliseconds: the others waited for a slot.
		expect(steps).toEqual([2, 4, 5]);
	});

	it("limits each key by itself, and a key without a limit to one at a time", async () => {
		const a = gauge();
		const b = gauge();
		const unknown = gauge();
		await withLimiter(
			{ limits: { a: { maxInFlight: 1 }, b: { maxInFlight: 3 } } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const fibers = yield* Effect.forEach([1, 2, 3], () =>
					Effect.forkChild(
						Effect.all(
							[
								limiter.withPermit("a", a.work),
								limiter.withPermit("b", b.work),
								limiter.withPermit("x", unknown.work),
							],
							{ concurrency: "unbounded" },
						),
					),
				);
				yield* TestClock.adjust("30 millis");
				yield* Effect.forEach(fibers, Fiber.join);
			}),
		);
		expect([a.seen.max, b.seen.max, unknown.seen.max]).toEqual([1, 3, 1]);
		expect([a.seen.done, b.seen.done, unknown.seen.done]).toEqual([3, 3, 3]);
	});

	it("releases the slot when the effect fails or is interrupted", async () => {
		const ran = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				yield* Effect.exit(limiter.withPermit("k", Effect.fail("boom")));
				const stuck = yield* Effect.forkChild(limiter.withPermit("k", Effect.never));
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(stuck);
				return yield* limiter.withPermit("k", Effect.succeed("ran"));
			}),
		);
		expect(ran).toBe("ran");
	});
});

describe("Limiter.backOff", () => {
	it("holds the key back for the base wait, on the Clock, with no real waiting", async () => {
		const started = performance.now();
		const result = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } }, backoff: { baseMillis: 1_000, maxMillis: 60_000 } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const wait = yield* limiter.backOff("k");
				const fiber = yield* Effect.forkChild(limiter.withPermit("k", Clock.currentTimeMillis));
				yield* TestClock.adjust("999 millis");
				const early = fiber.pollUnsafe() !== undefined;
				yield* TestClock.adjust("1 millis");
				return { wait, early, ranAt: yield* Fiber.join(fiber) };
			}),
		);
		expect(result).toEqual({ wait: 1_000, early: false, ranAt: 1_000 });
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("doubles the wait for each rate limit in a row and never passes the cap", async () => {
		const waits = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } }, backoff: { baseMillis: 100, maxMillis: 1_000 } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const waits: number[] = [];
				for (let index = 0; index < 6; index++) {
					const wait = yield* limiter.backOff("k");
					waits.push(wait);
					// The next rate limit comes from a request that started after this wait had passed.
					yield* TestClock.adjust(wait);
				}
				return waits;
			}),
		);
		expect(waits).toEqual([100, 200, 400, 800, 1_000, 1_000]);
	});

	it("starts from the base again once a request on the key was served", async () => {
		const waits = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } }, backoff: { baseMillis: 100, maxMillis: 1_000 } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const first = yield* limiter.backOff("k");
				yield* TestClock.adjust(first);
				const second = yield* limiter.backOff("k");
				yield* TestClock.adjust(second);
				yield* limiter.recover("k");
				return [first, second, yield* limiter.backOff("k")];
			}),
		);
		expect(waits).toEqual([100, 200, 100]);
	});

	it("does not double for a rate limit that arrives while the key already waits", async () => {
		const result = await withLimiter(
			{ limits: { k: { maxInFlight: 4 } }, backoff: { baseMillis: 100, maxMillis: 1_000 } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				// Four requests of one burst are all answered with a rate limit.
				const burst = [yield* limiter.backOff("k"), yield* limiter.backOff("k"), yield* limiter.backOff("k")];
				yield* TestClock.adjust("50 millis");
				burst.push(yield* limiter.backOff("k"));
				const fiber = yield* Effect.forkChild(limiter.withPermit("k", Clock.currentTimeMillis));
				// The last one of the burst extends the wait: 50 + 100.
				yield* TestClock.adjust("100 millis");
				return { burst, ranAt: yield* Fiber.join(fiber) };
			}),
		);
		expect(result).toEqual({ burst: [100, 100, 100, 100], ranAt: 150 });
	});

	it("honours a retry-after hint instead of the exponential wait, up to the cap", async () => {
		const result = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } }, backoff: { baseMillis: 100, maxMillis: 10_000 } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const hinted = yield* limiter.backOff("k", 7_000);
				const fiber = yield* Effect.forkChild(limiter.withPermit("k", Clock.currentTimeMillis));
				yield* TestClock.adjust("6999 millis");
				const early = fiber.pollUnsafe() !== undefined;
				yield* TestClock.adjust("1 millis");
				const ranAt = yield* Fiber.join(fiber);
				return { hinted, early, ranAt, capped: yield* limiter.backOff("k", 3_600_000) };
			}),
		);
		expect(result).toEqual({ hinted: 7_000, early: false, ranAt: 7_000, capped: 10_000 });
	});

	it("backs off one key only", async () => {
		const ranAt = await withLimiter(
			{ limits: { a: { maxInFlight: 1 }, b: { maxInFlight: 1 } } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				yield* limiter.backOff("a");
				return yield* limiter.withPermit("b", Clock.currentTimeMillis);
			}),
		);
		expect(ranAt).toBe(0);
	});

	it("uses one second and a cap of one minute when the options give no backoff", async () => {
		const waits = await withLimiter(
			{ limits: {} },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				const waits: number[] = [];
				for (let index = 0; index < 8; index++) {
					const wait = yield* limiter.backOff("k");
					waits.push(wait);
					yield* TestClock.adjust(wait);
				}
				return waits;
			}),
		);
		expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
	});

	it("lets a waiting effect be interrupted, and frees its slot", async () => {
		const result = await withLimiter(
			{ limits: { k: { maxInFlight: 1 } } },
			Effect.gen(function* () {
				const limiter = yield* Limiter;
				yield* limiter.backOff("k");
				let ran = false;
				const waiting = yield* Effect.forkChild(
					limiter.withPermit(
						"k",
						Effect.sync(() => {
							ran = true;
						}),
					),
				);
				yield* TestClock.adjust("500 millis");
				yield* Fiber.interrupt(waiting);
				const exit = yield* Effect.exit(Fiber.join(waiting));
				const next = yield* Effect.forkChild(limiter.withPermit("k", Clock.currentTimeMillis));
				yield* TestClock.adjust("500 millis");
				return { ran, interrupted: Exit.hasInterrupts(exit), nextRanAt: yield* Fiber.join(next) };
			}),
		);
		expect(result).toEqual({ ran: false, interrupted: true, nextRanAt: 1_000 });
	});
});
