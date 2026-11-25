import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidPriceTable, PriceMissing, Prices, PriceTable } from "../src/index.ts";

const TABLE = {
	currency: "USD",
	prices: [
		{
			provider: "acme",
			model: "large",
			input: 3_000_000,
			output: 15_000_000,
			cacheRead: 300_000,
			cacheWrite: 3_750_000,
		},
		{ provider: "acme", model: "small", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	],
};

const cost = (model: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
	Effect.runPromise(
		Prices.use((prices) => prices.cost("acme", model, usage)).pipe(Effect.provide(Prices.layer(TABLE))),
	);

describe("Prices", () => {
	it("prices each kind of token per million, in micro units, exactly", async () => {
		// 1000 * 3 + 200 * 15 + 5000 * 0.3 + 400 * 3.75 = 3000 + 3000 + 1500 + 1500 micro units.
		expect(await cost("large", { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 400 })).toBe(9000n);
		expect(await cost("large", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0n);
	});

	it("rounds a response up to the next micro unit, once", async () => {
		// One token of each kind at a millionth of a micro unit: four millionths, not four roundings to one.
		expect(await cost("small", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBe(1n);
		// 1 * 3 micro units and a third of a token's worth more: 3.3 rounds up to 4.
		expect(await cost("large", { input: 1, output: 0, cacheRead: 1, cacheWrite: 0 })).toBe(4n);
	});

	it("stays exact where a float would not", async () => {
		const tokens = Number.MAX_SAFE_INTEGER;
		expect(await cost("large", { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0 })).toBe(
			(BigInt(tokens) * 18_000_000n + 999_999n) / 1_000_000n,
		);
	});

	it("rounds a count that is not a whole number up, and counts one that is not a positive number as zero", async () => {
		expect(await cost("large", { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(3n);
		expect(
			await cost("large", { input: Number.NaN, output: -5, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 0 }),
		).toBe(0n);
	});

	it("fails with PriceMissing for a model the table does not list", async () => {
		const error = await Effect.runPromise(
			Prices.use((prices) => Effect.flip(prices.priceOf("acme", "medium"))).pipe(
				Effect.provide(Prices.layer(TABLE)),
			),
		);
		expect(error).toBeInstanceOf(PriceMissing);
		expect(error).toMatchObject({ provider: "acme", model: "medium" });
		expect(error.message).toBe("The price table has no price for acme/medium");
	});

	it("carries the currency and gives a listed price as it is", async () => {
		const [currency, price] = await Effect.runPromise(
			Prices.use((prices) =>
				Effect.map(prices.priceOf("acme", "large"), (found) => [prices.currency, found] as const),
			).pipe(Effect.provide(Prices.layer(TABLE))),
		);
		expect(currency).toBe("USD");
		expect(price).toEqual(TABLE.prices[0]);
	});

	it("refuses a table that prices a model twice, and one with a price that is not a whole number", async () => {
		const build = (table: PriceTable) =>
			Effect.runPromise(
				Effect.flip(
					Effect.provide(
						Prices.use(() => Effect.void),
						Prices.layer(table),
					),
				),
			);
		const twice = await build({ currency: "USD", prices: [TABLE.prices[0], TABLE.prices[0]] });
		expect(twice).toBeInstanceOf(InvalidPriceTable);
		expect(twice.message).toBe("The price table cannot be used: acme/large is priced twice");
		const fraction = await build({ currency: "USD", prices: [{ ...TABLE.prices[0], input: 0.5 }] });
		expect(fraction).toBeInstanceOf(InvalidPriceTable);
		const negative = await build({ currency: "USD", prices: [{ ...TABLE.prices[0], output: -1 }] });
		expect(negative).toBeInstanceOf(InvalidPriceTable);
	});

	it("is data: a table decodes from JSON", () => {
		expect(Schema.decodeUnknownSync(PriceTable)(JSON.parse(JSON.stringify(TABLE)))).toEqual(TABLE);
	});
});

/**
 * The price rows of a route table as `priceRows` of `@gunta/pi-router-effect` gives them, written out: an alias
 * `author` with two routes, an alias `fast` with the first of them, under the router's provider id `router`. A row
 * per route's model at the route's price, then a row per alias at the highest price of its routes for each kind.
 */
const ROUTER_ROWS = {
	currency: "USD",
	prices: [
		{ provider: "first", model: "m", input: 3000000, output: 15000000, cacheRead: 300000, cacheWrite: 3750000 },
		{ provider: "second", model: "m", input: 1000000, output: 20000000, cacheRead: 100000, cacheWrite: 5000000 },
		{ provider: "router", model: "author", input: 3000000, output: 20000000, cacheRead: 300000, cacheWrite: 5000000 },
		{ provider: "router", model: "fast", input: 3000000, output: 15000000, cacheRead: 300000, cacheWrite: 3750000 },
	],
};

describe("the price rows of a route table", () => {
	it("decode as a price table as they are, and build the prices of a budget", async () => {
		const table = Schema.decodeUnknownSync(PriceTable)(JSON.parse(JSON.stringify(ROUTER_ROWS)));
		expect(table).toEqual(ROUTER_ROWS);
		const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
		const priced = await Effect.runPromise(
			Prices.use((prices) =>
				Effect.all([
					// A response names the route that served it: each route's model at its own price.
					prices.cost("first", "m", usage),
					prices.cost("second", "m", usage),
					// A request to an alias is checked against the alias's row, which no route's price exceeds.
					prices.cost("router", "author", usage),
					prices.cost("router", "fast", usage),
				]),
			).pipe(Effect.provide(Prices.layer(table))),
		);
		expect(priced).toEqual([4_500n, 3_000n, 5_000n, 4_500n]);
	});
});
