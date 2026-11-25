import { calculateCost, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { emptyUsage } from "@gunta/pi-ai-effect";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	InvalidPriceTable,
	type ModelPrice,
	PriceMissing,
	Prices,
	type PricesService,
	PriceTable,
	type TokenUsage,
} from "../src/index.ts";

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

const cost = (model: string, usage: TokenUsage) =>
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

describe("pi-ai's rule", () => {
	const LARGE: ModelPrice = TABLE.prices[0];

	/** `LARGE`, and from 200,000 input tokens on twice as much. */
	const TIERED: ModelPrice = {
		...LARGE,
		tiers: [
			{ inputTokensAbove: 200_000, input: 6_000_000, output: 30_000_000, cacheRead: 600_000, cacheWrite: 7_500_000 },
		],
	};

	/** `use` of the `Prices` of a table that lists `price` alone. */
	function priceWith<A, E>(price: ModelPrice, use: (prices: PricesService) => Effect.Effect<A, E>) {
		return Effect.provide(Prices.use(use), Prices.layer({ currency: "USD", prices: [price] }));
	}

	/** What pi-ai's own `calculateCost` charges for `counts` at `price`, in micro units: its rates are in units. */
	function piCost(price: ModelPrice, counts: Partial<Usage>): number {
		const rate = (micros: number) => micros / 1_000_000;
		const rates = (of: ModelPrice | NonNullable<ModelPrice["tiers"]>[number]) => ({
			input: rate(of.input),
			output: rate(of.output),
			cacheRead: rate(of.cacheRead),
			cacheWrite: rate(of.cacheWrite),
		});
		const model = {
			...fauxProvider({ provider: price.provider, models: [{ id: price.model }] }).getModel(),
			cost: {
				...rates(price),
				tiers: price.tiers?.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, ...rates(tier) })),
			},
		};
		return calculateCost(model, { ...emptyUsage(), ...counts }).total * 1_000_000;
	}

	const USAGES: ReadonlyArray<TokenUsage> = [
		{ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 400 },
		{ input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 },
		{ input: 50, output: 20, cacheRead: 100, cacheWrite: 900, cacheWrite1h: 300 },
		{ input: 250_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
		{ input: 150_000, output: 10, cacheRead: 40_000, cacheWrite: 10_001, cacheWrite1h: 1 },
		{ input: 200_000, output: 10, cacheRead: 0, cacheWrite: 0 },
	];

	it("gives what pi-ai's calculateCost gives for the same usage and model, rounded up once", () =>
		runTest(
			Effect.gen(function* () {
				for (const price of [LARGE, TIERED]) {
					for (const usage of USAGES) {
						const micros = Number(yield* priceWith(price, (prices) => prices.cost("acme", "large", usage)));
						// pi-ai adds floats; the exact cost is at most one micro unit below ours.
						expect(micros - piCost(price, usage)).toBeGreaterThanOrEqual(-1e-6);
						expect(micros - piCost(price, usage)).toBeLessThan(1);
					}
				}
			}),
		));

	it("charges a cache write kept for one hour at twice the input rate", async () => {
		// 1000 input tokens at 3 and 1000 one-hour cache writes at 6 micro units per token, not at 3.75.
		expect(await cost("large", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 })).toBe(
			9000n,
		);
		// The other cache writes stay at the cache-write rate, and one-hour writes count at most all of them.
		expect(await cost("large", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 400 })).toBe(
			4650n,
		);
		expect(await cost("large", { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWrite1h: 50 })).toBe(60n);
	});

	it("charges all tokens of a request above a tier's threshold at the tier's rates", () =>
		runTest(
			Effect.gen(function* () {
				const charge = (usage: TokenUsage) => priceWith(TIERED, (prices) => prices.cost("acme", "large", usage));
				expect(yield* charge({ input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(600_000n);
				// Cache reads and writes count toward the threshold: 200,000 and 1 input tokens.
				expect(yield* charge({ input: 200_000, output: 0, cacheRead: 1, cacheWrite: 0 })).toBe(1_200_001n);
			}),
		));
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
