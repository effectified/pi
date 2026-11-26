import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { emptyUsage } from "@effectified/pi-ai";
import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { cost, type Price, type TokenUsage } from "../src/index.ts";
import { priced } from "../src/price.ts";
import { PRICE, route, scripted } from "./scripted.ts";

const NONE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("cost", () => {
	it("is exact for a known usage", async () => {
		// 1234 x 3.000000 + 567 x 15.000000 + 8000 x 0.300000 + 400 x 3.750000 micro units per token.
		const usage = { input: 1234, output: 567, cacheRead: 8000, cacheWrite: 400 };
		expect(await Effect.runPromise(cost(route("a"), usage))).toEqual({ currency: "USD", micros: 16_107n });
	});

	it("takes a route or anything with a price, and carries the price's currency", async () => {
		const price = { currency: "JPY", input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 };
		expect(await Effect.runPromise(cost({ price }, { ...NONE, input: 10, output: 5 }))).toEqual({
			currency: "JPY",
			micros: 20n,
		});
	});

	it("rounds up to the next micro unit once, over the sum", async () => {
		// One token at 0.25 micro units each kind: 1.0 in total, not four times one.
		const price = { currency: "USD", input: 250_000, output: 250_000, cacheRead: 250_000, cacheWrite: 250_000 };
		const one = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
		expect((await Effect.runPromise(cost({ price }, one))).micros).toBe(1n);
		expect((await Effect.runPromise(cost({ price }, { ...NONE, input: 1 }))).micros).toBe(1n);
		expect((await Effect.runPromise(cost({ price }, { ...NONE, input: 5 }))).micros).toBe(2n);
	});

	it("is zero for no tokens and for a free route", async () => {
		expect((await Effect.runPromise(cost(route("a"), NONE))).micros).toBe(0n);
		const free = { currency: "USD", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		expect((await Effect.runPromise(cost({ price: free }, { ...NONE, input: 1_000_000 }))).micros).toBe(0n);
	});

	it("stays exact where a float would not", async () => {
		// 9007199254740991 tokens at 75 per token: far beyond what a double holds exactly.
		const price = { ...PRICE, output: 75_000_000 };
		const usage = { ...NONE, output: Number.MAX_SAFE_INTEGER };
		expect((await Effect.runPromise(cost({ price }, usage))).micros).toBe(675_539_944_105_574_325n);
	});

	it("fails with InvalidUsage for a count that is not a whole number of tokens", async () => {
		const fraction = await Effect.runPromise(Effect.flip(cost(route("a"), { ...NONE, output: 1.5 })));
		expect(fraction._tag).toBe("InvalidUsage");
		expect(fraction).toMatchObject({ kind: "output", count: 1.5 });
		expect(fraction.message).toBe("The output token count 1.5 is not a whole number of tokens");
		const negative = await Effect.runPromise(Effect.flip(cost(route("a"), { ...NONE, cacheRead: -1 })));
		expect(negative).toMatchObject({ kind: "cacheRead", count: -1 });
		const nan = await Effect.runPromise(Effect.flip(cost(route("a"), { ...NONE, input: Number.NaN })));
		expect(nan.kind).toBe("input");
	});
});

describe("priced", () => {
	it("is the arithmetic of cost for whole counts", async () => {
		const usage = { input: 1234, output: 567, cacheRead: 8000, cacheWrite: 400 };
		expect(priced(PRICE, usage)).toEqual(await Effect.runPromise(cost({ price: PRICE }, usage)));
		expect(priced(PRICE, usage)).toEqual({ currency: "USD", micros: 16_107n });
		expect(priced(PRICE, NONE)).toEqual({ currency: "USD", micros: 0n });
	});

	it("never fails: a count that is not whole is rounded up, one that is not a positive number counts as zero", () => {
		// The rule of the budget package, so both settle the same amount: 0.5 input tokens are charged as one.
		expect(priced(PRICE, { ...NONE, input: 0.5 }).micros).toBe(3n);
		expect(
			priced(PRICE, { input: Number.NaN, output: -5, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 0 }),
		).toEqual({
			currency: "USD",
			micros: 0n,
		});
		// One token of each kind at a millionth of a micro unit: rounded up once, over the sum.
		const small = { currency: "USD", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
		expect(priced(small, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }).micros).toBe(1n);
	});
});

describe("pi-ai's rule", () => {
	/** `PRICE`, and from 200,000 input tokens on twice as much. */
	const TIERED: Price = {
		...PRICE,
		tiers: [
			{ inputTokensAbove: 200_000, input: 6_000_000, output: 30_000_000, cacheRead: 600_000, cacheWrite: 7_500_000 },
		],
	};

	/** What pi-ai's own `calculateCost` charges for `counts` at `price`, in micro units: its rates are in units. */
	function piCost(price: Price, counts: Partial<Usage>): number {
		const rate = (micros: number) => micros / 1_000_000;
		const rates = (of: Price | NonNullable<Price["tiers"]>[number]) => ({
			input: rate(of.input),
			output: rate(of.output),
			cacheRead: rate(of.cacheRead),
			cacheWrite: rate(of.cacheWrite),
		});
		const model = {
			...scripted("a").getModel(),
			cost: {
				...rates(price),
				tiers: price.tiers?.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, ...rates(tier) })),
			},
		};
		return calculateCost(model, { ...emptyUsage(), ...counts }).total * 1_000_000;
	}

	const USAGES: ReadonlyArray<TokenUsage> = [
		{ input: 1234, output: 567, cacheRead: 8000, cacheWrite: 400 },
		{ input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 },
		{ input: 50, output: 20, cacheRead: 100, cacheWrite: 900, cacheWrite1h: 300 },
		{ input: 250_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
		{ input: 150_000, output: 10, cacheRead: 40_000, cacheWrite: 10_001, cacheWrite1h: 1 },
		{ input: 200_000, output: 10, cacheRead: 0, cacheWrite: 0 },
	];

	it("gives what pi-ai's calculateCost gives for the same usage and model, rounded up once", () =>
		runTest(
			Effect.gen(function* () {
				for (const price of [PRICE, TIERED]) {
					for (const usage of USAGES) {
						const micros = Number((yield* cost({ price }, usage)).micros);
						// pi-ai adds floats; the exact cost is at most one micro unit below ours.
						expect(micros - piCost(price, usage)).toBeGreaterThanOrEqual(-1e-6);
						expect(micros - piCost(price, usage)).toBeLessThan(1);
					}
				}
			}),
		));

	it("charges a cache write kept for one hour at twice the input rate", () => {
		// 1000 input tokens at 3 and 1000 one-hour cache writes at 6 micro units per token, not at 3.75.
		const usage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 };
		expect(priced(PRICE, usage).micros).toBe(9000n);
		// The other cache writes stay at the cache-write rate: 600 x 3.75 + 400 x 6.
		expect(priced(PRICE, { ...usage, input: 0, cacheWrite1h: 400 }).micros).toBe(4650n);
	});

	it("charges all tokens of a request above a tier's threshold at the tier's rates", () => {
		expect(priced(TIERED, { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }).micros).toBe(600_000n);
		// Cache reads and writes count toward the threshold: 200,000 and 1 input tokens.
		expect(priced(TIERED, { input: 200_000, output: 0, cacheRead: 1, cacheWrite: 0 }).micros).toBe(1_200_001n);
	});

	it("counts one-hour writes at most all of cacheWrite, and fails for one that is not a whole number", async () => {
		expect(priced(PRICE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 50 }).micros).toBe(60n);
		const error = await runTest(Effect.flip(cost({ price: PRICE }, { ...NONE, cacheWrite: 2, cacheWrite1h: 1.5 })));
		expect(error).toMatchObject({ _tag: "InvalidUsage", kind: "cacheWrite1h", count: 1.5 });
	});
});
