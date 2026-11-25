import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PriceRows, PriceRowsError, priceRows, type RouteTable } from "../src/index.ts";
import { PRICE, route, table } from "./scripted.ts";

/** USD 1, 20, 0.10 and 5 per million tokens: dearer than `PRICE` for output and cache writes, cheaper for the rest. */
const OTHER = { currency: "USD", input: 1_000_000, output: 20_000_000, cacheRead: 100_000, cacheWrite: 5_000_000 };

const TABLE: RouteTable = table([
	{ alias: "author", routes: [route("first"), route("second", { price: OTHER })] },
	// The same model as the author's first route, at the same price: one row.
	{ alias: "fast", routes: [route("first")] },
]);

describe("priceRows", () => {
	it("gives a row per route's model at the route's price, then a row per alias under the router's id", async () => {
		expect(await Effect.runPromise(priceRows(TABLE))).toEqual({
			currency: "USD",
			prices: [
				{
					provider: "first",
					model: "m",
					input: 3_000_000,
					output: 15_000_000,
					cacheRead: 300_000,
					cacheWrite: 3_750_000,
				},
				{
					provider: "second",
					model: "m",
					input: 1_000_000,
					output: 20_000_000,
					cacheRead: 100_000,
					cacheWrite: 5_000_000,
				},
				// The highest price of the alias's routes for each kind of token: no route charges more.
				{
					provider: "router",
					model: "author",
					input: 3_000_000,
					output: 20_000_000,
					cacheRead: 300_000,
					cacheWrite: 5_000_000,
				},
				{
					provider: "router",
					model: "fast",
					input: 3_000_000,
					output: 15_000_000,
					cacheRead: 300_000,
					cacheWrite: 3_750_000,
				},
			],
		});
	});

	it("names the alias rows by the id the router is built with", async () => {
		const rows = await Effect.runPromise(priceRows(TABLE, "routes"));
		expect(rows.prices.map((row) => `${row.provider}/${row.model}`)).toEqual([
			"first/m",
			"second/m",
			"routes/author",
			"routes/fast",
		]);
	});

	it("is plain data: the rows encode to JSON and decode back", async () => {
		const rows = await Effect.runPromise(priceRows(TABLE));
		expect(Schema.decodeUnknownSync(PriceRows)(JSON.parse(JSON.stringify(rows)))).toEqual(rows);
	});

	it("fails when routes are priced in more than one currency", async () => {
		const mixed = table([
			{ alias: "author", routes: [route("first"), route("second", { price: { ...PRICE, currency: "JPY" } })] },
		]);
		const error = await Effect.runPromise(Effect.flip(priceRows(mixed)));
		expect(error).toBeInstanceOf(PriceRowsError);
		expect(error.issues).toEqual([{ _tag: "MixedCurrencies", currencies: ["USD", "JPY"] }]);
		expect(error.message).toBe("The routes are priced in more than one currency: USD, JPY");
	});

	it("fails when one model has two prices, and when an alias row would share a route's name", async () => {
		const twice = table([
			{ alias: "author", routes: [route("first")] },
			{ alias: "fast", routes: [route("first", { price: OTHER })] },
		]);
		const error = await Effect.runPromise(Effect.flip(priceRows(twice)));
		expect(error.issues).toEqual([{ _tag: "ConflictingPrice", provider: "first", model: "m" }]);
		expect(error.message).toBe("first/m has more than one price");

		// A route to another router's alias of the same name, at another price than this alias's own row.
		const shared = table([
			{ alias: "m", routes: [route("router", { price: OTHER }), route("first")] },
			{ alias: "fast", routes: [route("first")] },
		]);
		const collision = await Effect.runPromise(Effect.flip(priceRows(shared)));
		expect(collision.issues).toEqual([{ _tag: "ConflictingPrice", provider: "router", model: "m" }]);
	});

	it("carries a route's tiers, and prices an alias at the highest rate of its routes and their tiers", async () => {
		const tier = {
			inputTokensAbove: 200_000,
			input: 6_000_000,
			output: 30_000_000,
			cacheRead: 0,
			cacheWrite: 7_500_000,
		};
		const tiered = table([
			{
				alias: "author",
				routes: [route("first", { price: { ...PRICE, tiers: [tier] } }), route("second", { price: OTHER })],
			},
		]);
		const rows = await runTest(priceRows(tiered));
		expect(rows.prices).toEqual([
			{
				provider: "first",
				model: "m",
				input: 3_000_000,
				output: 15_000_000,
				cacheRead: 300_000,
				cacheWrite: 3_750_000,
				tiers: [tier],
			},
			{
				provider: "second",
				model: "m",
				input: 1_000_000,
				output: 20_000_000,
				cacheRead: 100_000,
				cacheWrite: 5_000_000,
			},
			// No route charges more than this row for any request, a large one to `first` included.
			{
				provider: "router",
				model: "author",
				input: 6_000_000,
				output: 30_000_000,
				cacheRead: 300_000,
				cacheWrite: 7_500_000,
			},
		]);
		expect(Schema.decodeUnknownSync(PriceRows)(JSON.parse(JSON.stringify(rows)))).toEqual(rows);
	});

	it("fails when one model has two prices that differ only in their tiers", async () => {
		const tier = {
			inputTokensAbove: 200_000,
			input: 3_000_000,
			output: 15_000_000,
			cacheRead: 300_000,
			cacheWrite: 3_750_000,
		};
		const twice = table([
			{ alias: "author", routes: [route("first", { price: { ...PRICE, tiers: [tier] } })] },
			{ alias: "fast", routes: [route("first")] },
		]);
		const error = await runTest(Effect.flip(priceRows(twice)));
		expect(error.issues).toEqual([{ _tag: "ConflictingPrice", provider: "first", model: "m" }]);
	});

	it("fails for a table without a route: it has no price and no currency", async () => {
		const error = await Effect.runPromise(Effect.flip(priceRows(table([]))));
		expect(error.issues).toEqual([{ _tag: "NoRoute" }]);
		expect(error.message).toBe("The route table has no route");
	});
});
