// Resolution: the routes of an alias that may serve a request with given constraints, in table order.

import { Effect } from "effect";
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
export function resolveRoutes(
	table: RouteTable,
	alias: string,
	constraints?: Constraints,
	imposed?: Constraints,
): Effect.Effect<readonly [Route, ...Route[]], UnknownAlias | InvalidConstraints | NoRouteAvailable> {
	const entry = table.aliases.find((candidate) => candidate.alias === alias);
	if (entry === undefined) return Effect.fail(new UnknownAlias({ alias }));
	return Effect.flatMap(combine(table, entry, constraints, imposed ?? {}), (asked) => {
		const allowed: Route[] = [];
		const excluded: Exclusion[] = [];
		for (const route of entry.routes) {
			const { provider, model } = route;
			const missing = asked.requires.filter((label) => !(route.labels ?? []).includes(label));
			if (table.classifications.indexOf(route.ceiling) < asked.rank) {
				excluded.push({ provider, model, reason: "classification" });
			} else if (asked.regions !== undefined && !asked.regions.includes(route.region)) {
				excluded.push({ provider, model, reason: "region" });
			} else if (missing.length > 0) {
				excluded.push({ provider, model, reason: "label", missing });
			} else allowed.push(route);
		}
		const [first, ...rest] = allowed;
		if (first !== undefined) return Effect.succeed([first, ...rest] as const);
		const { classification, regions } = asked;
		const requires = asked.requires.length === 0 ? undefined : asked.requires;
		return Effect.fail(new NoRouteAvailable({ alias, classification, regions, requires, excluded }));
	});
}

/** What a request is checked against, once the request, its alias and the product have had their say. */
interface Asked {
	readonly classification: string;
	/** The position of `classification` in the table's labels. */
	readonly rank: number;
	/** Absent when every region may serve. */
	readonly regions: ReadonlyArray<string> | undefined;
	/** Each required label once; empty when none is required. */
	readonly requires: ReadonlyArray<string>;
}

/** Combines the three parties by the rule of `resolveRoutes`. Fails for a classification the table does not list. */
function combine(
	table: RouteTable,
	entry: Alias,
	request: Constraints | undefined,
	imposed: Constraints,
): Effect.Effect<Asked, InvalidConstraints> {
	const { alias, defaults } = entry;
	const labels = table.classifications;
	const invalid = (reason: string) => Effect.fail(new InvalidConstraints({ alias, reason }));
	const named = [request?.classification ?? defaults?.classification, imposed.classification].filter(
		(label) => label !== undefined,
	);
	const unknown = named.find((label) => !labels.includes(label));
	if (unknown !== undefined) return invalid(`"${unknown}" is not a classification of the route table`);
	// Content no party classifies is the highest label; otherwise the stricter of the labels named.
	const rank = named.length === 0 ? labels.length - 1 : Math.max(...named.map((label) => labels.indexOf(label)));
	const classification = labels[rank];
	// A table without labels has no route that passed validation, so there is nothing a request could be checked against.
	if (classification === undefined) return invalid("the route table lists no classification");
	const own = request?.regions ?? defaults?.regions;
	const regions =
		own === undefined || imposed.regions === undefined
			? (own ?? imposed.regions)
			: own.filter((region) => imposed.regions?.includes(region));
	const requires = [...new Set([...(request?.requires ?? defaults?.requires ?? []), ...(imposed.requires ?? [])])];
	return Effect.succeed({ classification, rank, regions, requires });
}
