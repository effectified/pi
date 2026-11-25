// The route table as data: aliases, their routes, classifications, labels, limits and prices, decoded and validated.

import type { Api, Model } from "@earendil-works/pi-ai";
import { Models } from "@gunta/pi-ai-effect";
import { Effect, Schema } from "effect";
import { Constraints, Label } from "./constraints.ts";
import { RouteTableError, type RouteTableIssue } from "./errors.ts";

const Micros = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The rates of a large request, as pi-ai's `ModelCostTier`: a request whose input tokens (`input`, `cacheRead` and
 * `cacheWrite` together) are more than `inputTokensAbove` is charged at these rates for all of its tokens.
 */
export const PriceTier = Schema.Struct({
	inputTokensAbove: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	input: Micros,
	output: Micros,
	cacheRead: Micros,
	cacheWrite: Micros,
});

/** The rates of a large request. */
export type PriceTier = typeof PriceTier.Type;

/**
 * What a route charges, per million tokens, in integer micro units of `currency` (one millionth of a unit: USD 3
 * per million tokens is 3000000). The four kinds are pi-ai's: `input` is the input neither read from nor written
 * to the cache, and `output` includes reasoning. Cache writes kept for one hour cost twice `input`, as pi-ai
 * charges them. `tiers`, as pi-ai's model costs have them: the tier with the highest threshold below a request's
 * input replaces the four rates for that request.
 */
export const Price = Schema.Struct({
	/** A label the product chooses, such as an ISO 4217 code. The router only carries it. */
	currency: Schema.String,
	input: Micros,
	output: Micros,
	cacheRead: Micros,
	cacheWrite: Micros,
	tiers: Schema.optional(Schema.Array(PriceTier)),
});

/** What a route charges, per million tokens, in integer micro units. */
export type Price = typeof Price.Type;

/** One way to serve an alias: a model of a pi-ai provider, where it runs, what it may see and what it costs. */
export const Route = Schema.Struct({
	/** The id of a provider registered in `Models`. */
	provider: Schema.String,
	/** The id of a chat model that provider lists. */
	model: Schema.String,
	/** A label for where the route runs. A request that allows only some regions is served from those. */
	region: Schema.String,
	/** The highest classification of content the route may see: one of the table's `classifications`. */
	ceiling: Schema.String,
	price: Price,
	/** The key of `limits` whose slots and backoff the route shares with every route that names it. */
	concurrencyKey: Schema.String,
	/**
	 * What the product says of the route, such as `zero-data-retention` or `batch`: a request that requires labels is
	 * served only by a route that carries every one of them. A route without the field carries none.
	 */
	labels: Schema.optional(Schema.Array(Label)),
});

/** One way to serve an alias. */
export type Route = typeof Route.Type;

/** A name callers ask for, and the routes that may serve it, in the order they are tried. */
export const Alias = Schema.Struct({
	alias: Schema.String,
	/** Display name of the alias model. Default: `alias`. */
	name: Schema.optional(Schema.String),
	/** The constraints of a request that carries none; a request's own constraints win field by field. */
	defaults: Schema.optional(Constraints),
	routes: Schema.Array(Route),
});

/** A name callers ask for, and the routes that may serve it. */
export type Alias = typeof Alias.Type;

const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The limit of one concurrency key. */
export const Limit = Schema.Struct({
	/** How many requests may be in flight on the key at once. */
	maxInFlight: Positive,
});

/** The limit of one concurrency key. */
export type Limit = typeof Limit.Type;

/** How long a key waits after a rate limit: `baseMillis`, doubled for each one in a row, never above `maxMillis`. */
export const Backoff = Schema.Struct({
	baseMillis: Positive,
	maxMillis: Positive,
});

/** How long a key waits after a rate limit. */
export type Backoff = typeof Backoff.Type;

/** The whole routing policy of one router, as data a product can store, load and review. */
export const RouteTable = Schema.Struct({
	/** The product's classification labels, lowest to highest. The router knows no label of its own. */
	classifications: Schema.Array(Schema.String),
	/** The limit of every concurrency key a route names. */
	limits: Schema.Record(Schema.String, Limit),
	/** Default: one second, at most one minute. */
	backoff: Schema.optional(Backoff),
	aliases: Schema.Array(Alias),
});

/** The whole routing policy of one router. */
export type RouteTable = typeof RouteTable.Type;

/** A table that passed `validateRouteTable`, and per alias the pi-ai model of each route as `Models` listed it then. */
export interface ValidRouteTable {
	readonly table: RouteTable;
	readonly aliases: ReadonlyArray<{ readonly entry: Alias; readonly models: ReadonlyArray<Model<Api>> }>;
}

const decodeTable = Schema.decodeUnknownEffect(RouteTable);

/**
 * `input` as a route table. Wire input: fails with the issue `Malformed` when it is not the shape of one, which
 * includes a price that is not a whole number and a label that is empty or has white space.
 */
export function decodeRouteTable(input: unknown): Effect.Effect<RouteTable, RouteTableError> {
	return Effect.mapError(
		decodeTable(input),
		(error) => new RouteTableError({ issues: [{ _tag: "Malformed", message: error.message }] }),
	);
}

/**
 * Checks the table against its schema, and then what the schema cannot say: labels and aliases are unique, no alias
 * is empty or names a route twice, every classification and concurrency key a route or an alias names exists, and
 * every route names a chat model that a provider in `Models` lists now. Fails with every issue found, in table
 * order; a table that is not the shape of one fails with the issue `Malformed` alone.
 */
export function validateRouteTable(input: RouteTable): Effect.Effect<ValidRouteTable, RouteTableError, Models> {
	// The schema runs here too: the types of a table written in code cannot say that a price is a whole number.
	return Effect.flatMap(decodeRouteTable(input), check);
}

/** The checks the schema cannot make, over a table that has the shape of one. */
function check(table: RouteTable): Effect.Effect<ValidRouteTable, RouteTableError, Models> {
	return Models.use((registered) => {
		const issues: RouteTableIssue[] = [];
		const aliases: { readonly entry: Alias; readonly models: Model<Api>[] }[] = [];
		for (const label of duplicates(table.classifications)) issues.push({ _tag: "DuplicateClassification", label });
		for (const alias of duplicates(table.aliases.map((entry) => entry.alias))) {
			issues.push({ _tag: "DuplicateAlias", alias });
		}
		for (const entry of table.aliases) {
			const { alias, defaults, routes } = entry;
			const models: Model<Api>[] = [];
			aliases.push({ entry, models });
			if (routes.length === 0) issues.push({ _tag: "EmptyAlias", alias });
			const label = defaults?.classification;
			if (label !== undefined && !table.classifications.includes(label)) {
				issues.push({ _tag: "UnknownDefaultClassification", alias, label });
			}
			const named = new Set<string>();
			for (const route of routes) {
				const { provider, model } = route;
				// A NUL cannot be part of either id, so two different routes never share a key.
				const key = `${provider}\0${model}`;
				if (named.has(key)) issues.push({ _tag: "DuplicateRoute", alias, provider, model });
				named.add(key);
				if (!table.classifications.includes(route.ceiling)) {
					issues.push({ _tag: "UnknownCeiling", alias, provider, model, label: route.ceiling });
				}
				if (!Object.hasOwn(table.limits, route.concurrencyKey)) {
					issues.push({ _tag: "UnknownConcurrencyKey", alias, provider, model, key: route.concurrencyKey });
				}
				const listed = registered.getModel(provider, model);
				if (listed !== undefined) models.push(listed);
				else if (registered.getProvider(provider) === undefined) {
					issues.push({ _tag: "UnknownProvider", alias, provider });
				} else issues.push({ _tag: "UnknownModel", alias, provider, model });
			}
		}
		const [first, ...rest] = issues;
		return first === undefined
			? Effect.succeed({ table, aliases })
			: Effect.fail(new RouteTableError({ issues: [first, ...rest] }));
	});
}

/** The values that occur more than once, each once, in the order of their second occurrence. */
function duplicates(values: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) twice.add(value);
		else seen.add(value);
	}
	return [...twice];
}
