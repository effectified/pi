// The route table as data: aliases, their routes, classifications, labels, limits and prices, decoded and validated.

import { type Api, type Model, ModelId, Models, type MutableModels, ProviderId } from "@effectified/pi-ai";
import { Array as Arr, Effect, Equivalence, Option, Record, Schema } from "effect";
import { Constraints, Label } from "./constraints.ts";
import { RouteTableError, RouteTableIssue } from "./errors.ts";
import { ConcurrencyKey } from "./ids.ts";

/** A whole number, zero or more: an amount in micro units, or a number of tokens. */
const Whole = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The rates of a large request, as pi-ai's `ModelCostTier`: a request whose input tokens (`input`, `cacheRead` and
 * `cacheWrite` together) are more than `inputTokensAbove` is charged at these rates for all of its tokens.
 */
export const PriceTier = Schema.Struct({
	inputTokensAbove: Whole,
	input: Whole,
	output: Whole,
	cacheRead: Whole,
	cacheWrite: Whole,
});

/** The rates of a large request. */
export type PriceTier = typeof PriceTier.Type;

/**
 * What a route charges, per million tokens, in integer micro units of `currency` (one millionth of a unit: USD 3
 * per million tokens is 3000000), zero or more. The four kinds are pi-ai's: `input` is the input neither read from
 * nor written to the cache, and `output` includes reasoning. Cache writes kept for one hour cost twice `input`, as
 * pi-ai charges them. `tiers`, as pi-ai's model costs have them: the tier with the highest threshold below a request's
 * input replaces the four rates for that request.
 */
export const Price = Schema.Struct({
	/** A label the product chooses, such as an ISO 4217 code. The router only carries it. */
	currency: Schema.String,
	input: Whole,
	output: Whole,
	cacheRead: Whole,
	cacheWrite: Whole,
	tiers: Schema.optional(Schema.Array(PriceTier)),
});

/** What a route charges, per million tokens, in integer micro units. */
export type Price = typeof Price.Type;

/** One way to serve an alias: a model of a pi-ai provider, where it runs, what it may see and what it costs. */
export const Route = Schema.Struct({
	/** The id of a provider registered in `Models`. */
	provider: ProviderId,
	/** The id of a chat model that provider lists. */
	model: ModelId,
	/** A label for where the route runs. A request that allows only some regions is served from those. */
	region: Schema.String,
	/** The highest classification of content the route may see: one of the table's `classifications`. */
	ceiling: Schema.String,
	price: Price,
	/** The key of `limits` whose slots and backoff the route shares with every route that names it. */
	concurrencyKey: ConcurrencyKey,
	/**
	 * What the product says of the route, such as `zero-data-retention` or `batch`: a request that requires labels is
	 * served only by a route that carries every one of them. A route without the field carries none.
	 */
	labels: Schema.optional(Schema.Array(Label)),
});

/** One way to serve an alias. */
export type Route = typeof Route.Type;

/** Whether two routes, or two rows of prices, name one model of one provider. */
export const sameModel: Equivalence.Equivalence<{ readonly provider: string; readonly model: string }> =
	Equivalence.Struct({ provider: Equivalence.String, model: Equivalence.String });

/** A name callers ask for, and the routes that may serve it, in the order they are tried. */
export const Alias = Schema.Struct({
	/** The name: the id of the alias's model under the router's provider (`{ provider: "router", modelId: alias }`). */
	alias: ModelId,
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

/**
 * The whole routing policy of one router, as data a product can store, load and review. Its type has the ids branded
 * (`ProviderId`, `ModelId`, `ConcurrencyKey`); its encoded form, `typeof RouteTable.Encoded`, has plain strings and is
 * what a product writes in code or stores. `Router.layer`, `validateRouteTable` and `priceRows` take either.
 */
export const RouteTable = Schema.Struct({
	/** The product's classification labels, lowest to highest. The router knows no label of its own. */
	classifications: Schema.Array(Schema.String),
	/** The limit of every concurrency key a route names. */
	limits: Schema.Record(ConcurrencyKey, Limit),
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

/**
 * `input` as a route table. Wire input: fails with the issue `Malformed` when it is not the shape of one, which
 * includes a price that is not a whole number and a label that is empty or has white space.
 */
export const decodeRouteTable: (input: unknown) => Effect.Effect<RouteTable, RouteTableError> = Effect.fn(
	"RouteTable.decodeRouteTable",
)(function* (input) {
	return yield* Effect.mapError(Schema.decodeUnknownEffect(RouteTable)(input), malformed);
});

function malformed(error: Schema.SchemaError): RouteTableError {
	return RouteTableError.make({ issues: [{ _tag: "Malformed", message: error.message }] });
}

/**
 * Checks the table against its schema, and then what the schema cannot say: labels and aliases are unique, no alias
 * is empty or names a route twice, every classification and concurrency key a route or an alias names exists, and
 * every route names a chat model that a provider in `Models` lists now. Fails with every issue found, in table
 * order; a table that is not the shape of one fails with the issue `Malformed` alone.
 */
export const validateRouteTable: (
	input: typeof RouteTable.Encoded,
) => Effect.Effect<ValidRouteTable, RouteTableError, Models> = Effect.fn("RouteTable.validateRouteTable")(
	function* (input) {
		// The schema runs here too: the types of a table written in code cannot say that a price is a whole number.
		const table = yield* Effect.mapError(Schema.decodeEffect(RouteTable)(input), malformed);
		const registered = yield* Models;
		const { DuplicateAlias, DuplicateClassification } = RouteTableIssue.cases;
		const issues: Array<RouteTableIssue> = [
			...Arr.map(duplicates(table.classifications), (label) => DuplicateClassification.make({ label })),
			...Arr.map(duplicates(Arr.map(table.aliases, (entry) => entry.alias)), (alias) =>
				DuplicateAlias.make({ alias }),
			),
			...Arr.flatMap(table.aliases, (entry) => aliasIssues(table, entry, registered)),
		];
		if (Arr.isArrayNonEmpty(issues)) return yield* RouteTableError.make({ issues });
		const aliases = Arr.map(table.aliases, (entry) => ({
			entry,
			models: Arr.flatMap(entry.routes, (route) =>
				Option.toArray(Option.fromUndefinedOr(registered.getModel(route.provider, route.model))),
			),
		}));
		return { table, aliases };
	},
);

/** The issues of one alias of a decoded table, in table order: the alias's own, then its routes'. */
function aliasIssues(table: RouteTable, entry: Alias, registered: MutableModels): ReadonlyArray<RouteTableIssue> {
	const { alias, defaults, routes } = entry;
	const label = defaults?.classification;
	const unknownDefault: ReadonlyArray<RouteTableIssue> =
		label === undefined || Arr.contains(table.classifications, label)
			? []
			: [{ _tag: "UnknownDefaultClassification", alias, label }];
	return [
		...when(Arr.isReadonlyArrayEmpty(routes), { _tag: "EmptyAlias", alias }),
		...unknownDefault,
		...Arr.flatMap(routes, (route, index): ReadonlyArray<RouteTableIssue> => {
			const { provider, model } = route;
			return [
				...when(Arr.containsWith(sameModel)(Arr.take(routes, index), route), {
					_tag: "DuplicateRoute",
					alias,
					provider,
					model,
				}),
				...when(!Arr.contains(table.classifications, route.ceiling), {
					_tag: "UnknownCeiling",
					alias,
					provider,
					model,
					label: route.ceiling,
				}),
				...when(!Record.has(table.limits, route.concurrencyKey), {
					_tag: "UnknownConcurrencyKey",
					alias,
					provider,
					model,
					key: route.concurrencyKey,
				}),
				...registration(registered, alias, route),
			];
		}),
	];
}

/** `issue` when `holds`, else nothing. */
function when<I extends RouteTableIssue>(holds: boolean, issue: I): ReadonlyArray<I> {
	return holds ? [issue] : [];
}

/** What `Models` lacks for a route: its provider, or the provider's chat model. */
function registration(registered: MutableModels, alias: ModelId, route: Route): ReadonlyArray<RouteTableIssue> {
	const { provider, model } = route;
	if (registered.getModel(provider, model) !== undefined) return [];
	return registered.getProvider(provider) === undefined
		? [{ _tag: "UnknownProvider", alias, provider }]
		: [{ _tag: "UnknownModel", alias, provider, model }];
}

/** The values that occur more than once, each once, in the order of their second occurrence. */
function duplicates<A extends string>(values: ReadonlyArray<A>): Array<A> {
	return Arr.dedupe(Arr.filter(values, (value, index) => Arr.contains(Arr.take(values, index), value)));
}
