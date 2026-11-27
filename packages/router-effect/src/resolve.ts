// Resolution: the routes of an alias that may serve a request with given constraints, in table order.

import type { ModelId } from "@effectified/pi-ai";
import { Array as Arr, Effect, Option, Order, Result } from "effect";
import type { Constraints } from "./constraints.ts";
import { type Exclusion, InvalidConstraints, NoRouteAvailable, UnknownAlias } from "./errors.ts";
import type { Alias, Route, RouteTable } from "./route-table.ts";

/**
 * The routes of `alias` that may serve a request, in the order they are tried. A route is never used when its ceiling
 * is below the content's classification, when regions are given and its region is not one of them, or when it lacks a
 * required label. Fails with `NoRouteAvailable` when no route is left: there is no default route.
 *
 * Three parties say what constrains a request, and they combine in two steps:
 *
 * 1. **The request over the alias.** A request's `constraints` win over the alias's `defaults` field by field: a
 *    default only fills in what the request does not say.
 * 2. **`imposed` over both**, never wider. `imposed` is what the product's `ConstraintSource` says of the
 *    conversation. The stricter classification holds (the higher label of the table). Regions intersect: a route
 *    must be in a region both allow, and when they share none, no route serves. Required labels add up. A field
 *    only one side names is that side's.
 *
 * Content no party classifies is treated as the highest label of the table.
 */
export const resolveRoutes: (
	table: RouteTable,
	alias: ModelId,
	constraints?: Constraints,
	imposed?: Constraints,
) => Effect.Effect<Arr.NonEmptyReadonlyArray<Route>, UnknownAlias | InvalidConstraints | NoRouteAvailable> = Effect.fn(
	"Resolve.resolveRoutes",
)(function* (table, alias, constraints, imposed = {}) {
	const found = Arr.findFirst(table.aliases, (candidate) => candidate.alias === alias);
	if (Option.isNone(found)) return yield* UnknownAlias.make({ alias });
	const entry = found.value;
	const ranks = byRank(table);
	const asked = yield* combine(table, ranks, entry, constraints, imposed);
	const [allowed, excluded] = Arr.separate(Arr.map(entry.routes, (route) => verdict(ranks, asked, route)));
	if (Arr.isArrayNonEmpty(allowed)) return allowed;
	const { classification, regions } = asked;
	const requires = Arr.isReadonlyArrayNonEmpty(asked.requires) ? asked.requires : undefined;
	return yield* NoRouteAvailable.make({ alias, classification, regions, requires, excluded });
});

/** What a request is checked against, once the request, its alias and the product have had their say. */
interface Asked {
	readonly classification: string;
	/** Absent when every region may serve. */
	readonly regions: ReadonlyArray<string> | undefined;
	/** Each required label once; empty when none is required. */
	readonly requires: ReadonlyArray<string>;
}

/**
 * Combines the three parties by the rule of `resolveRoutes`. Fails for a classification the table does not list.
 * Untraced: a step of `Resolve.resolveRoutes`'s span.
 */
const combine = Effect.fnUntraced(function* (
	table: RouteTable,
	ranks: Order.Order<string>,
	entry: Alias,
	request: Constraints | undefined,
	imposed: Constraints,
): Effect.fn.Return<Asked, InvalidConstraints> {
	const { alias, defaults } = entry;
	const labels = table.classifications;
	const named = Arr.getSomes([
		Option.fromUndefinedOr(request?.classification ?? defaults?.classification),
		Option.fromUndefinedOr(imposed.classification),
	]);
	const unknown = Arr.findFirst(named, (label) => !Arr.contains(labels, label));
	if (Option.isSome(unknown)) {
		return yield* InvalidConstraints.make({
			alias,
			reason: `"${unknown.value}" is not a classification of the route table`,
		});
	}
	// Content no party classifies is the highest label; otherwise the stricter of the labels named.
	const classification = Arr.isArrayNonEmpty(named) ? Option.some(Arr.max(named, ranks)) : Arr.last(labels);
	// A table without labels has no route that passed validation, so there is nothing a request could be checked against.
	if (Option.isNone(classification)) {
		return yield* InvalidConstraints.make({ alias, reason: "the route table lists no classification" });
	}
	const own = request?.regions ?? defaults?.regions;
	const regions =
		own === undefined || imposed.regions === undefined
			? (own ?? imposed.regions)
			: Arr.intersection(own, imposed.regions);
	const requires = Arr.dedupe(Arr.appendAll(request?.requires ?? defaults?.requires ?? [], imposed.requires ?? []));
	return { classification: classification.value, regions, requires };
});

/** The table's labels, lowest to highest: a label the table does not list is below every one. */
function byRank(table: RouteTable): Order.Order<string> {
	return Order.mapInput(Order.Number, (label: string) => table.classifications.indexOf(label));
}

/**
 * Whether `route` may serve what was `asked`, or why not: the first of a ceiling below the classification, a region
 * not allowed and a missing label that holds.
 */
function verdict(ranks: Order.Order<string>, asked: Asked, route: Route): Result.Result<Route, Exclusion> {
	const { provider, model } = route;
	if (Order.isLessThan(ranks)(route.ceiling, asked.classification)) {
		return Result.fail({ provider, model, reason: "classification" });
	}
	if (asked.regions !== undefined && !Arr.contains(asked.regions, route.region)) {
		return Result.fail({ provider, model, reason: "region" });
	}
	const missing = Arr.filter(asked.requires, (label) => !Arr.contains(route.labels ?? [], label));
	return Arr.isArrayNonEmpty(missing)
		? Result.fail({ provider, model, reason: "label", missing })
		: Result.succeed(route);
}
