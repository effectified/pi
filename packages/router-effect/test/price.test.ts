import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { cost, type TokenUsage } from "../src/index.ts";
import { noUsage, priced } from "../src/price.ts";
import { PRICE, route } from "./scripted.ts";

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

describe("noUsage", () => {
	it("is pi-ai's usage of nothing, a new object each time", () => {
		expect(noUsage()).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(noUsage()).not.toBe(noUsage());
	});
});
