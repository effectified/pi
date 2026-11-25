import { complete, type Models } from "@gunta/pi-ai-effect";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, ScriptedModels } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	type BudgetEvents,
	BudgetedModels,
	Estimator,
	LeaseFenced,
	PriceMissing,
	Shares,
	Spend,
	type SpentUsage,
	stopOf,
} from "../src/index.ts";
import { type Budgeted, budgetedHarness, ESTIMATE, expectedCost, prices, TestLease, withEvents } from "./support.ts";

/** A second model of the table: what a router's other route would be. */
const BACKUP = { provider: "backup-lab", model: "writer-b" };
const BACKUP_PRICE = { input: 1_000_000, output: 5_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 };

/**
 * Runs a test body on a budgeted harness whose table also lists the backup. A harness, because a spend that names a
 * session waits for the shares to be attached to one, as a request does.
 */
const run = <A, E>(body: Effect.Effect<A, E, Harness.Harness | Budgeted>) =>
	Effect.runPromise(Effect.provide(body, budgetedHarness({ prices: [{ ...BACKUP, ...BACKUP_PRICE }] })));

/**
 * The attempts of one request of a router, as plain data: the fields of its route events a product reads. The first
 * route failed after it had used tokens and the second took the request over and served it.
 */
const ATTEMPTS = [
	{
		requestId: "lz4k2q9xw-1",
		sessionId: "session-7",
		attempt: 1,
		route: { provider: "faux", model: "faux-1" },
		outcome: "failed",
		fallback: true,
		usage: { input: 1200, output: 0, cacheRead: 300, cacheWrite: 0 },
	},
	{
		requestId: "lz4k2q9xw-1",
		sessionId: "session-7",
		attempt: 2,
		route: BACKUP,
		outcome: "served",
		fallback: false,
		usage: { input: 1200, output: 80, cacheRead: 300, cacheWrite: 0 },
	},
] as const;

/** What a product forwards: the attempts another route took over, each under the key of its request and number. */
function forwarded(attempts: ReadonlyArray<(typeof ATTEMPTS)[number]>): ReadonlyArray<SpentUsage> {
	return attempts
		.filter((attempt) => attempt.fallback)
		.map((attempt) => ({
			key: `${attempt.requestId}#${attempt.attempt}`,
			provider: attempt.route.provider,
			model: attempt.route.model,
			session: attempt.sessionId,
			usage: attempt.usage,
			// An attempt another route took over failed: an abort never starts a fallback.
			outcome: "failed",
		}));
}

const [FAILED] = forwarded(ATTEMPTS);

describe("Spend.record", () => {
	it("charges a failed attempt at the price of its own model, as a reservation of exactly its cost, settled at once", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				expect(forwarded(ATTEMPTS)).toEqual([FAILED]);
				// 1200 x 1.500001 + 300 x 0.3 micro units, rounded up once.
				const cost = expectedCost(FAILED.usage);
				expect(cost).toBe(1_891n);
				const [recorded, events] = yield* withEvents(2, spend.record(FAILED));
				expect(recorded).toEqual({ _tag: "Settled", reservation: "r1", cost });
				const request = {
					kind: "chat",
					provider: "faux",
					model: "faux-1",
					session: "session-7",
					key: "lz4k2q9xw-1#1",
				};
				expect(lease.steps).toEqual([
					{ step: "reserve", token: "r1", estimate: cost, request },
					{ step: "settle", token: "r1", settlement: { usage: FAILED.usage, cost, outcome: "failed" } },
				]);
				expect(events).toMatchObject([
					{ _tag: "Reserved", request, reservation: "r1", estimate: cost, currency: "USD" },
					{
						_tag: "Settled",
						request,
						reservation: "r1",
						estimate: cost,
						usage: FAILED.usage,
						cost,
						outcome: "failed",
						currency: "USD",
					},
				]);
			}),
		));

	it("charges a key once in a process, however often the product tells it", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				const first = yield* spend.record(FAILED);
				const [again, events] = yield* withEvents(0, spend.record(FAILED));
				const both = yield* Effect.all([spend.record(FAILED), spend.record({ ...FAILED, key: "lz4k2q9xw-2#1" })], {
					concurrency: "unbounded",
				});
				expect(first._tag).toBe("Settled");
				expect(again).toEqual({ _tag: "Duplicate" });
				expect(events).toEqual([]);
				expect(both.map((recorded) => recorded._tag)).toEqual(["Duplicate", "Settled"]);
				// Two keys, two charges: the other attempt of the same shape is another spend.
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle", "reserve", "settle"]);
			}),
		));

	it("charges two tellings of one key at the same moment once", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				const both = yield* Effect.all([spend.record(FAILED), spend.record(FAILED)], { concurrency: "unbounded" });
				expect(both.map((recorded) => recorded._tag).sort()).toEqual(["Duplicate", "Settled"]);
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
			}),
		));

	it("does not count the attempt that served twice: the wrapper settles it, the product forwards the rest", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const spend = yield* Spend;
				yield* scripted.setResponses([answer("It is 42.")]);
				// The request of the harness: one reservation, settled with what the serving route used.
				const message = yield* complete(scripted.model, {
					messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }],
				});
				for (const spent of forwarded(ATTEMPTS)) yield* spend.record(spent);
				const settled = lease.steps.flatMap((step) => (step.step === "settle" ? [step.settlement] : []));
				expect(settled.map(({ outcome }) => outcome)).toEqual(["returned", "failed"]);
				// The lease was told the response and the one failed attempt, each once: their sum and nothing more.
				expect(settled.reduce((sum, { cost }) => sum + cost, 0n)).toBe(
					expectedCost(message.usage) + expectedCost(FAILED.usage),
				);
				expect(lease.steps.filter((step) => step.step === "reserve").map((step) => step.estimate)).toEqual([
					ESTIMATE,
					expectedCost(FAILED.usage),
				]);
			}),
		));

	it("prices by the model that was used, not by the alias that was asked", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
				const recorded = yield* spend.record({ key: "a#1", ...BACKUP, usage, outcome: "aborted" });
				// 1000 x 1.0 + 100 x 5.0 micro units: the backup's own price.
				expect(recorded).toEqual({ _tag: "Settled", reservation: "r1", cost: 1_500n });
				expect(lease.steps[1]).toEqual({
					step: "settle",
					token: "r1",
					settlement: { usage, cost: 1_500n, outcome: "aborted" },
				});
				// No session was told, so the request names none.
				expect(lease.steps[0]).toMatchObject({ request: { kind: "chat", ...BACKUP, key: "a#1" } });
				expect(lease.steps[0]).not.toHaveProperty("request.session");
			}),
		));

	it("records nothing for a model without a price, and the key stays unused", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				const unknown = { ...FAILED, provider: "nowhere", model: "none" };
				const [error, events] = yield* withEvents(1, Effect.flip(spend.record(unknown)));
				expect(error).toBeInstanceOf(PriceMissing);
				expect(error).toMatchObject({ provider: "nowhere", model: "none" });
				expect(events).toMatchObject([
					{ _tag: "Refused", request: { key: FAILED.key }, refusal: { _tag: "PriceMissing" } },
				]);
				expect(lease.steps).toEqual([]);
				// The same key with a model the table lists is charged: the refusal used nothing up.
				expect((yield* spend.record(FAILED))._tag).toBe("Settled");
			}),
		));

	it("records nothing on a fenced lease, and the same spend is charged under a new lease", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				lease.fenced = "expired";
				const [error, events] = yield* withEvents(1, Effect.flip(spend.record(FAILED)));
				expect(error).toEqual(new LeaseFenced({ reason: "expired" }));
				expect(events).toMatchObject([
					{ _tag: "Refused", request: { key: FAILED.key }, refusal: { _tag: "LeaseFenced", reason: "expired" } },
				]);
				expect(lease.steps).toEqual([{ step: "fenced", reason: "expired" }]);
				// The product renews its lease and tells the spend again, under the same key.
				lease.fenced = undefined;
				expect(yield* spend.record(FAILED)).toEqual({
					_tag: "Settled",
					reservation: "r1",
					cost: expectedCost(FAILED.usage),
				});
				expect(yield* spend.record(FAILED)).toEqual({ _tag: "Duplicate" });
			}),
		));

	it("uses the key up once the lease has the reservation, also when its settle breaks", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				lease.brokenSettle = new Error("ledger down");
				const [exit, events] = yield* withEvents(1, Effect.exit(spend.record(FAILED)));
				expect(exit._tag).toBe("Failure");
				// The reservation was published; a settlement that died publishes nothing, as for a request.
				expect(events.map((event) => event._tag)).toEqual(["Reserved"]);
				lease.brokenSettle = undefined;
				expect(yield* spend.record(FAILED)).toEqual({ _tag: "Duplicate" });
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
			}),
		));

	it("settles a pair of zero for usage that costs nothing", () =>
		run(
			Effect.gen(function* () {
				const lease = yield* TestLease;
				const spend = yield* Spend;
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				expect(yield* spend.record({ ...FAILED, usage })).toEqual({ _tag: "Settled", reservation: "r1", cost: 0n });
				expect(lease.steps.map((step) => (step.step === "reserve" ? step.estimate : step.step))).toEqual([
					0n,
					"settle",
				]);
			}),
		));
});

describe("a recorded spend and a conversation's share", () => {
	it("counts against the conversation of its session, stores the total, and passes the cap without a refusal", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const shares = yield* Shares;
				const spend = yield* Spend;
				yield* scripted.setResponses([answer("One."), answer("Never.")]);
				const child = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: { provider: scripted.model.provider, modelId: scripted.model.id } },
				});
				const cost = expectedCost(FAILED.usage);
				yield* shares.setCap(child.id, cost);
				expect(yield* child.prompt("First")).toMatchObject({ status: "done" });
				const [reserve, settle] = lease.steps;
				if (reserve?.step !== "reserve" || settle?.step !== "settle") throw new Error("a reserve and a settle");
				const session = reserve.request.session;
				const served = settle.settlement.cost;
				expect(served).toBeLessThan(cost);

				// The failed attempt of that conversation's request, told with the session the router's event carried.
				const recorded = yield* spend.record({ ...FAILED, session });
				expect(recorded).toEqual({ _tag: "Settled", reservation: "r2", cost, conversation: child.id });
				expect(lease.steps[2]).toMatchObject({
					step: "reserve",
					estimate: cost,
					request: { session, conversation: child.id, key: FAILED.key },
				});
				// The money is spent: the share takes it over its cap, and the stored total says so.
				expect(yield* shares.get(child.id)).toEqual(
					Option.some({ conversation: child.id, cap: cost, settled: served + cost }),
				);
				// The conversation's next request finds the cap reached.
				expect(yield* child.prompt("Second")).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(Option.getOrThrow(yield* stopOf(child.id)).refusal).toMatchObject({
					_tag: "ShareExhausted",
					cap: cost,
					settled: served + cost,
				});
				expect(yield* scripted.callCount).toBe(1);
			}),
		));

	it("counts against no share for a session that has none, and for a budget without shares", async () => {
		await run(
			Effect.gen(function* () {
				const spend = yield* Spend;
				expect(yield* spend.record(FAILED)).toEqual({
					_tag: "Settled",
					reservation: "r1",
					cost: expectedCost(FAILED.usage),
				});
			}),
		);
		// `BudgetedModels.layer`: the same service, on a budget that has no shares to wait for.
		const plain: Layer.Layer<Models | BudgetEvents | Spend | TestLease> = BudgetedModels.layer.pipe(
			Layer.provideMerge(Layer.mergeAll(TestLease.layer, Estimator.fixed(ESTIMATE))),
			Layer.provide(prices()),
			Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })),
		);
		const steps = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Spend.use((spend) => spend.record(FAILED));
				return (yield* TestLease).steps;
			}).pipe(Effect.provide(plain)),
		);
		expect(steps).toMatchObject([
			{ step: "reserve", request: { session: "session-7", key: FAILED.key } },
			{ step: "settle", settlement: { cost: expectedCost(FAILED.usage), outcome: "failed" } },
		]);
		expect(steps[0]).not.toHaveProperty("request.conversation");
	});
});
