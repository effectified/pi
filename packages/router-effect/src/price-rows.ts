// A route table's prices as plain rows: what a budget needs to price the same models, written once.

import { ModelId, ProviderId, type TokenKind } from "@effectified/pi-ai";
import { Array as Arr, Effect, Equivalence, Schema } from "effect";
import { DEFAULT_ROUTER_ID } from "./ids.ts";
import { Price, type RouteTable, sameModel } from "./route-table.ts";

/**
 * What one model charges, per million tokens, in integer micro units, zero or more: the rates and the tiers of
 * `Price`. A row names either the model of a route, or an alias under the router's provider id.
 */
export const PriceRow = Schema.Struct({
	provider: ProviderId,
	model: ModelId,
	input: Price.fields.input,
	output: Price.fields.output,
	cacheRead: Price.fields.cacheRead,
	cacheWrite: Price.fields.cacheWrite,
	tiers: Price.fields.tiers,
});

/** What one model charges, per million tokens, in integer micro units. */
export type PriceRow = typeof PriceRow.Type;

/**
 * The prices of a route table in one currency: the shape of the `PriceTable` of `@effectified/pi-budget`, which
 * decodes it as it is.
 */
export const PriceRows = Schema.Struct({
	currency: Schema.String,
	prices: Schema.Array(PriceRow),
});

/** The prices of a route table in one currency. */
export type PriceRows = typeof PriceRows.Type;

/**
 * One reason a route table has no single set of price rows. `PriceRowsIssue.match` picks a handler per tag and
 * `PriceRowsIssue.guards` tests for one.
 */
export const PriceRowsIssue = Schema.TaggedUnion({
	/** The table has no route, so it has no price and no currency. */
	NoRoute: {},
	/** Routes are priced in more than one currency; rows have one. `currencies` are in table order. */
	MixedCurrencies: { currencies: Schema.Array(Schema.String) },
	/** Two routes name this provider and model at different prices, or an alias row would share its name. */
	ConflictingPrice: { provider: ProviderId, model: ModelId },
});

/** One reason a route table has no single set of price rows. */
export type PriceRowsIssue = typeof PriceRowsIssue.Type;

/** A route table's prices cannot be given as rows. `issues` lists every reason. */
export class PriceRowsError extends Schema.TaggedError<PriceRowsError, { readonly brand: unique symbol }>()(
	"PriceRowsError",
	{ issues: Schema.NonEmptyArray(PriceRowsIssue) },
) {
	override get message(): string {
		return Arr.join(Arr.map(this.issues, describeIssue), "; ");
	}
}

function describeIssue(issue: PriceRowsIssue): string {
	return PriceRowsIssue.match(issue, {
		NoRoute: () => "The route table has no route",
		MixedCurrencies: ({ currencies }) =>
			`The routes are priced in more than one currency: ${Arr.join(currencies, ", ")}`,
		ConflictingPrice: ({ provider, model }) => `${provider}/${model} has more than one price`,
	});
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
 * prices its routes in more than one currency, or gives one model two prices. `table` is a decoded table or one
 * written in code (`typeof RouteTable.Encoded`); the ids of the rows are branded here.
 */
export const priceRows: (
	table: typeof RouteTable.Encoded,
	router?: ProviderId,
) => Effect.Effect<PriceRows, PriceRowsError> = Effect.fn("PriceRows.priceRows")(function* (
	table,
	router = DEFAULT_ROUTER_ID,
) {
	const routes = Arr.flatMap(table.aliases, (alias) => alias.routes);
	const routeRows = Arr.map(routes, (route): PriceRow => ({
		provider: ProviderId.make(route.provider),
		model: ModelId.make(route.model),
		...amounts(route.price),
	}));
	const aliasRows = Arr.flatMap(table.aliases, (alias) =>
		Arr.matchLeft(
			Arr.flatMap(alias.routes, (route): Array<Rates> => [route.price, ...(route.price.tiers ?? [])]),
			{
				onEmpty: (): Array<PriceRow> => [],
				onNonEmpty: (first, rest) => [
					{ provider: router, model: ModelId.make(alias.alias), ...Arr.reduce(rest, rates(first), highest) },
				],
			},
		),
	);
	const all = [...routeRows, ...aliasRows];
	const rows = Arr.dedupeWith(all, sameModel);
	const conflicts = Arr.flatMap(rows, (row): Array<PriceRowsIssue> =>
		Arr.some(all, (other) => sameModel(row, other) && !samePrice(row, other))
			? [{ _tag: "ConflictingPrice", provider: row.provider, model: row.model }]
			: [],
	);
	const currencies = Arr.dedupe(Arr.map(routes, (route) => route.price.currency));
	if (!Arr.isArrayNonEmpty(currencies)) return yield* PriceRowsError.make({ issues: [{ _tag: "NoRoute" }] });
	const issues: Array<PriceRowsIssue> = [
		...(currencies.length > 1 ? [{ _tag: "MixedCurrencies" as const, currencies }] : []),
		...conflicts,
	];
	if (Arr.isArrayNonEmpty(issues)) return yield* PriceRowsError.make({ issues });
	return { currency: Arr.headNonEmpty(currencies), prices: rows };
});

/** The rates of a price or of a tier. */
type Rates = Pick<Price, TokenKind>;

/** What a row charges: its rates and its tiers. */
type Amounts = Omit<PriceRow, "provider" | "model">;

/** A route's price as the amounts of a row: its rates, and its tiers when it has any. */
function amounts(price: typeof Price.Encoded): Amounts {
	const { tiers } = price;
	return { ...rates(price), ...(tiers === undefined ? {} : { tiers }) };
}

function rates(price: Rates): Rates {
	return { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: price.cacheWrite };
}

/** For each kind of token, the higher of two rates. */
function highest(one: Rates, other: Rates): Rates {
	return {
		input: Math.max(one.input, other.input),
		output: Math.max(one.output, other.output),
		cacheRead: Math.max(one.cacheRead, other.cacheRead),
		cacheWrite: Math.max(one.cacheWrite, other.cacheWrite),
	};
}

/** The four rates, each compared as a number. */
const RATES = {
	input: Equivalence.Number,
	output: Equivalence.Number,
	cacheRead: Equivalence.Number,
	cacheWrite: Equivalence.Number,
} satisfies Record<TokenKind, Equivalence.Equivalence<number>>;

/**
 * Whether two rows charge the same for every request: the same rates, and the same tiers in the same order. A row
 * without tiers and one with none charge the same.
 */
const samePrice: Equivalence.Equivalence<Amounts> = Equivalence.combine(
	Equivalence.Struct(RATES),
	Equivalence.mapInput(
		Equivalence.Array(Equivalence.Struct({ ...RATES, inputTokensAbove: Equivalence.Number })),
		(row: Amounts) => row.tiers ?? [],
	),
);
