import { runTest } from "@effectified/pi-ai/testing";
import { Deferred, Effect, Fiber, Latch } from "effect";
import { describe, expect, it } from "vitest";
import { settledBy } from "../src/attempt-settlement.ts";
import { AttemptSettlement, AttemptUnsettled, type RouteEvent } from "../src/index.ts";
import { failing, route } from "./scripted.ts";

/** The route event of a first attempt that failed after it was billed, and that the next route is taking over. */
const EVENT: RouteEvent = {
	router: "router",
	request: 1,
	requestId: "router-a-1",
	sessionId: "session-7",
	alias: "fast",
	route: route("a"),
	attempt: 1,
	outcome: "failed",
	fallback: true,
	errorMessage: "overloaded",
	usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
	cost: { currency: "USD", micros: 6n },
	startedAt: 0,
	waitedMillis: 0,
	durationMillis: 12,
};

/** The failed route's own answer. */
const RESPONSE = failing("overloaded");

/** What every `AttemptUnsettled` of `EVENT` says, whatever the reason. */
const NAMED = { alias: "fast", requestId: "router-a-1", attempt: 1, provider: "a", model: "m" };

/** Has the settlement of the context settle `EVENT`. */
const ask = Effect.gen(function* () {
	return yield* (yield* AttemptSettlement).settle(EVENT);
});

describe("AttemptSettlement", () => {
	it("does nothing unless a product provides one", async () => {
		expect(await Effect.runPromise(ask)).toBeUndefined();
	});

	it("is the product's when it provides one, and is handed the attempt's route event", async () => {
		const handed: RouteEvent[] = [];
		await Effect.runPromise(
			ask.pipe(
				Effect.provideService(AttemptSettlement, {
					settle: (event) =>
						Effect.sync(() => {
							handed.push(event);
						}),
				}),
			),
		);
		expect(handed).toEqual([EVENT]);
	});
});

describe("settledBy", () => {
	it("has the port settle the attempt, and ignores what the port answers", async () => {
		const handed: RouteEvent[] = [];
		const port = {
			settle: (event: RouteEvent) =>
				Effect.sync(() => {
					handed.push(event);
					return { _tag: "Settled", cost: 6n };
				}),
		};
		expect(await Effect.runPromise(settledBy(port, EVENT, RESPONSE))).toBeUndefined();
		expect(handed).toEqual([EVENT]);
	});

	it("fails with AttemptUnsettled when the port fails: it names the attempt, says why, and has the route's answer", async () => {
		// A failure of any type: the port is the product's, and so is what it fails with.
		const failures = [new Error("The budget lease is fenced: expired"), "no price for a/m"];
		const errors = await Effect.runPromise(
			Effect.forEach(failures, (failure) =>
				Effect.flip(settledBy({ settle: () => Effect.fail(failure) }, EVENT, RESPONSE)),
			),
		);
		expect(errors.map((error) => error.reason)).toEqual(["The budget lease is fenced: expired", "no price for a/m"]);
		for (const error of errors) {
			expect(error).toBeInstanceOf(AttemptUnsettled);
			expect(error).toMatchObject(NAMED);
			expect(error.response).toBe(RESPONSE);
		}
	});

	it("fails with AttemptUnsettled, naming the defect, when the port dies or throws", async () => {
		const died = await Effect.runPromise(
			Effect.flip(settledBy({ settle: () => Effect.die(new Error("ledger down")) }, EVENT, RESPONSE)),
		);
		expect(died).toMatchObject({ ...NAMED, reason: "the settlement port died: ledger down" });
		const threw = await Effect.runPromise(
			Effect.flip(
				settledBy(
					{
						settle: () => {
							throw "not an error";
						},
					},
					EVENT,
					RESPONSE,
				),
			),
		);
		expect(threw).toMatchObject({ ...NAMED, reason: "the settlement port died: not an error" });
	});

	it("cannot be interrupted: a port that was asked settles to its end, also when its caller gives up", async () => {
		const state = { settled: false };
		const result = await runTest(
			Effect.gen(function* () {
				const ledger = yield* Deferred.make<void>();
				const entered = yield* Latch.make();
				const port = {
					settle: () =>
						Effect.gen(function* () {
							yield* entered.open;
							yield* Deferred.await(ledger);
							state.settled = true;
						}),
				};
				const fiber = yield* Effect.forkChild(Effect.andThen(settledBy(port, EVENT, RESPONSE), Effect.never));
				yield* entered.await;
				// The interruption waits for the fiber, so it is asked for from a fiber of its own. Started at once,
				// it has reached the fiber when the fork returns; one turn of the scheduler lets the fiber react.
				const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
				yield* Effect.yieldNow;
				const meanwhile = { settled: state.settled, ended: fiber.pollUnsafe() !== undefined };
				yield* Deferred.succeed(ledger, undefined);
				yield* Fiber.join(interruption);
				return { meanwhile, ended: fiber.pollUnsafe() !== undefined };
			}),
		);
		// While the port waits, the interruption waits with it. Once it has settled, the interruption takes effect.
		expect(result.meanwhile).toEqual({ settled: false, ended: false });
		expect(state.settled).toBe(true);
		expect(result.ended).toBe(true);
	});
});
