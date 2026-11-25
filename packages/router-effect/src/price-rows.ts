// A route table's prices as plain rows: what a budget needs to price the same models, written once.

import { TOKEN_KINDS, type TokenKind } from "@gunta/pi-ai-effect";
import { Effect, Schema } from "effect";
import { type Price, PriceTier, type RouteTable } from "./route-table.ts";

/**
 * What one model charges, per million tokens, in integer micro units: the units and the tiers of `Price`. A row names
 * either the model of a route, or an alias under the router's provider id.
 */
export const PriceRow = Schema.Struct({
	provider: Schema.String,
	model: Schema.String,
	input: Schema.Int,
	output: Schema.Int,
	cacheRead: Schema.Int,
	cacheWrite: Schema.Int,
	tiers: Schema.optional(Schema.Array(PriceTier)),
});

/** What one model charges, per million tokens, in integer micro units. */
export type PriceRow = typeof PriceRow.Type;

/**
 * The prices of a route table in one currency: the shape of the `PriceTable` of `@gunta/pi-budget-effect`, which
 * decodes it as it is.
 */
export const PriceRows = Schema.Struct({
	currency: Schema.String,
	prices: Schema.Array(PriceRow),
});

/** The prices of a route table in one currency. */
export type PriceRows = typeof PriceRows.Type;

/** One reason a route table has no single set of price rows. */
export const PriceRowsIssue = Schema.Union([
	/** The table has no route, so it has no price and no currency. */
	Schema.TaggedStruct("NoRoute", {}),
	/** Routes are priced in more than one currency; rows have one. `currencies` are in table order. */
	Schema.TaggedStruct("MixedCurrencies", { currencies: Schema.Array(Schema.String) }),
	/** Two routes name this provider and model at different prices, or an alias row would share its name. */
	Schema.TaggedStruct("ConflictingPrice", { provider: Schema.String, model: Schema.String }),
]);

/** One reason a route table has no single set of price rows. */
export type PriceRowsIssue = typeof PriceRowsIssue.Type;

/** A route table's prices cannot be given as rows. `issues` lists every reason. */
export class PriceRowsError extends Schema.TaggedError<PriceRowsError>()("PriceRowsError", {
	issues: Schema.NonEmptyArray(PriceRowsIssue),
}) {
	override get message(): string {
		return this.issues.map(describeIssue).join("; ");
	}
}

function describeIssue(issue: PriceRowsIssue): string {
	switch (issue._tag) {
		case "NoRoute":
			return "The route table has no route";
		case "MixedCurrencies":
			return `The routes are priced in more than one currency: ${issue.currencies.join(", ")}`;
		case "ConflictingPrice":
			return `${issue.provider}/${issue.model} has more than one price`;
	}
}

/**
 * The prices of `table` as rows, so a product writes each price once, in its route table:
 *
 * - one row per route's model, at the route's price, its tiers included: what a response is charged at, since a
 *   response names the route that served it. A model several aliases route to has one row.
 * - one row per alias, under the provider id `router` (the `id` the router is built with), at the highest rate of
 *   its routes for each kind of token, of their tiers too, and with no tiers: the price of a request to the alias
 *   before it is known which route serves, never below what any route charges.
 *
 * Route rows first, then alias rows, each in table order. Fails with `PriceRowsError` when the table has no route,
 * prices its routes in more than one currency, or gives one model two prices.
 */
export function priceRows(table: RouteTable, router = "router"): Effect.Effect<PriceRows, PriceRowsError> {
	return Effect.suspend(() => {
		const rows = new Map<string, PriceRow>();
		const conflicts = new Map<string, PriceRowsIssue>();
		const add = (row: PriceRow) => {
			// A NUL cannot be part of either id, so two different models never share a key.
			const key = `${row.provider}\0${row.model}`;
			const known = rows.get(key);
			if (known === undefined) rows.set(key, row);
			else if (!samePrice(known, row)) {
				conflicts.set(key, { _tag: "ConflictingPrice", provider: row.provider, model: row.model });
			}
		};
		const routes = table.aliases.flatMap((alias) => alias.routes);
		for (const { provider, model, price } of routes) add({ provider, model, ...amounts(price) });
		for (const alias of table.aliases) {
			const [first, ...rest] = alias.routes.flatMap((route) => [route.price, ...(route.price.tiers ?? [])]);
			if (first !== undefined) add({ provider: router, model: alias.alias, ...rest.reduce(highest, rates(first)) });
		}
		const currencies = [...new Set(routes.map((route) => route.price.currency))];
		const issues: PriceRowsIssue[] = [
			...(currencies.length > 1 ? [{ _tag: "MixedCurrencies" as const, currencies }] : []),
			...conflicts.values(),
		];
		const [currency] = currencies;
		if (currency === undefined) return Effect.fail(new PriceRowsError({ issues: [{ _tag: "NoRoute" }] }));
		const [issue, ...more] = issues;
		return issue === undefined
			? Effect.succeed({ currency, prices: [...rows.values()] })
			: Effect.fail(new PriceRowsError({ issues: [issue, ...more] }));
	});
}

/** The rates of a price or of a tier. */
type Rates = Pick<Price, TokenKind>;

/** What a row charges: its rates and its tiers. */
type Amounts = Omit<PriceRow, "provider" | "model">;

/** A route's price as the amounts of a row: its rates, and its tiers when it has any. */
function amounts(price: Price): Amounts {
	const { tiers } = price;
	return { ...rates(price), ...(tiers === undefined ? {} : { tiers }) };
}

function rates(price: Rates): Record<TokenKind, number> {
	return { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
}

/** For each kind of token, the higher of two rates. */
function highest(one: Rates, other: Rates): Record<TokenKind, number> {
	return {
		input: Math.max(one.input, other.input),
		output: Math.max(one.output, other.output),
		cacheRead: Math.max(one.cacheRead, other.cacheRead),
		cacheWrite: Math.max(one.cacheWrite, other.cacheWrite),
	};
}

/** Whether two rows charge the same for every request: the same rates, and the same tiers in the same order. */
function samePrice(one: Amounts, other: Amounts): boolean {
	const tiers = one.tiers ?? [];
	const others = other.tiers ?? [];
	return (
		sameRates(one, other) &&
		tiers.length === others.length &&
		tiers.every(
			(tier, index) => tier.inputTokensAbove === others[index].inputTokensAbove && sameRates(tier, others[index]),
		)
	);
}

function sameRates(one: Rates, other: Rates): boolean {
	return TOKEN_KINDS.every((kind) => one[kind] === other[kind]);
}
