import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeRouteTable, type RouteTable, validateRouteTable } from "../src/index.ts";
import { modelsLayer, PRICE, route, scripted, table } from "./scripted.ts";

/** The issues `validateRouteTable` reports for `input` when `Models` holds the providers `a` and `b`. */
function issuesOf(input: RouteTable) {
	return Effect.runPromise(
		Effect.flip(validateRouteTable(input)).pipe(
			Effect.map((error) => error.issues),
			Effect.provide(modelsLayer(scripted("a"), scripted("b"))),
		),
	);
}

describe("decodeRouteTable", () => {
	it("decodes a table from JSON", async () => {
		const json = JSON.stringify(table([{ alias: "fast", defaults: { regions: ["us"] }, routes: [route("a")] }]));
		const decoded = await Effect.runPromise(decodeRouteTable(JSON.parse(json)));
		expect(decoded).toEqual({
			classifications: ["public", "internal", "secret"],
			limits: { a: { maxInFlight: 4 } },
			aliases: [
				{
					alias: "fast",
					defaults: { regions: ["us"] },
					routes: [
						{ provider: "a", model: "m", region: "us", ceiling: "public", price: PRICE, concurrencyKey: "a" },
					],
				},
			],
		});
	});

	it("fails with the Malformed issue for a value that is not a table", async () => {
		const error = await Effect.runPromise(Effect.flip(decodeRouteTable({ classifications: ["public"] })));
		expect(error._tag).toBe("RouteTableError");
		expect(error.issues).toHaveLength(1);
		expect(error.issues[0]._tag).toBe("Malformed");
		expect(error.message).toContain('["limits"]');
	});

	it("rejects a price that is negative or not a whole number of micro units", async () => {
		const withPrice = (input: number) =>
			table([{ alias: "fast", routes: [route("a", { price: { ...PRICE, input } })] }]);
		const negative = await Effect.runPromise(Effect.flip(decodeRouteTable(withPrice(-1))));
		const fraction = await Effect.runPromise(Effect.flip(decodeRouteTable(withPrice(0.5))));
		expect(negative.issues[0]._tag).toBe("Malformed");
		expect(negative.message).toContain('["price"]["input"]');
		expect(fraction.issues[0]._tag).toBe("Malformed");
		expect(fraction.message).toContain('["price"]["input"]');
	});

	it("decodes a route's labels and an alias's default labels, and leaves a route without labels as it is", async () => {
		const input = table([
			{
				alias: "fast",
				defaults: { requires: ["zero-data-retention"] },
				routes: [route("a", { labels: ["zero-data-retention", "byok:acme"] }), route("b")],
			},
		]);
		const decoded = await Effect.runPromise(decodeRouteTable(JSON.parse(JSON.stringify(input))));
		expect(decoded.aliases[0].defaults).toEqual({ requires: ["zero-data-retention"] });
		expect(decoded.aliases[0].routes.map((entry) => entry.labels)).toEqual([
			["zero-data-retention", "byok:acme"],
			undefined,
		]);
		expect(decoded.aliases[0].routes[1]).not.toHaveProperty("labels");
	});

	it("rejects a label that is empty or has white space, on a route and in an alias's defaults", async () => {
		const withLabel = (label: string) =>
			table([{ alias: "fast", routes: [route("a", { labels: ["batch", label] })] }]);
		for (const label of ["", " ", "zero data retention", "batch\n"]) {
			const error = await Effect.runPromise(Effect.flip(decodeRouteTable(withLabel(label))));
			expect(error.issues.map((issue) => issue._tag)).toEqual(["Malformed"]);
			expect(error.message).toContain('["aliases"][0]["routes"][0]["labels"][1]');
		}
		const defaults = table([{ alias: "fast", defaults: { requires: ["two words"] }, routes: [route("a")] }]);
		const error = await Effect.runPromise(Effect.flip(decodeRouteTable(defaults)));
		expect(error.message).toContain('["aliases"][0]["defaults"]["requires"][0]');
	});

	it("rejects a limit of no request in flight", async () => {
		const input = table([{ alias: "fast", routes: [route("a")] }], { limits: { a: { maxInFlight: 0 } } });
		const error = await Effect.runPromise(Effect.flip(decodeRouteTable(input)));
		expect(error.message).toContain('["limits"]["a"]["maxInFlight"]');
	});
});

describe("validateRouteTable", () => {
	it("returns the table with the pi-ai model of each route, per alias and in route order", async () => {
		const input = table([
			{ alias: "fast", routes: [route("a"), route("b")] },
			{ alias: "slow", routes: [route("b")] },
		]);
		const valid = await Effect.runPromise(
			validateRouteTable(input).pipe(Effect.provide(modelsLayer(scripted("a"), scripted("b")))),
		);
		expect(valid.table).toEqual(input);
		expect(
			valid.aliases.map(({ entry, models }) => [
				entry.alias,
				models.map((model) => `${model.provider}/${model.id}`),
			]),
		).toEqual([
			["fast", ["a/m", "b/m"]],
			["slow", ["b/m"]],
		]);
	});

	it("fails for a classification listed twice", async () => {
		const input = table([{ alias: "fast", routes: [route("a")] }], {
			classifications: ["public", "secret", "public"],
		});
		expect(await issuesOf(input)).toEqual([{ _tag: "DuplicateClassification", label: "public" }]);
	});

	it("fails for an alias defined twice", async () => {
		const input = table([
			{ alias: "fast", routes: [route("a")] },
			{ alias: "fast", routes: [route("b")] },
		]);
		expect(await issuesOf(input)).toEqual([{ _tag: "DuplicateAlias", alias: "fast" }]);
	});

	it("fails for an alias with no route", async () => {
		expect(await issuesOf(table([{ alias: "fast", routes: [] }]))).toEqual([{ _tag: "EmptyAlias", alias: "fast" }]);
	});

	it("fails for an alias whose default classification is not a label of the table", async () => {
		const input = table([{ alias: "fast", defaults: { classification: "topsecret" }, routes: [route("a")] }]);
		expect(await issuesOf(input)).toEqual([
			{ _tag: "UnknownDefaultClassification", alias: "fast", label: "topsecret" },
		]);
	});

	it("fails for an alias that names the same provider and model twice", async () => {
		const input = table([{ alias: "fast", routes: [route("a"), route("b"), route("a", { region: "eu" })] }]);
		expect(await issuesOf(input)).toEqual([{ _tag: "DuplicateRoute", alias: "fast", provider: "a", model: "m" }]);
	});

	it("fails for a route whose ceiling is not a label of the table", async () => {
		const input = table([{ alias: "fast", routes: [route("a", { ceiling: "topsecret" })] }]);
		expect(await issuesOf(input)).toEqual([
			{ _tag: "UnknownCeiling", alias: "fast", provider: "a", model: "m", label: "topsecret" },
		]);
	});

	it("fails for a route whose concurrency key has no limit", async () => {
		const input = table([{ alias: "fast", routes: [route("a")] }], { limits: {} });
		expect(await issuesOf(input)).toEqual([
			{ _tag: "UnknownConcurrencyKey", alias: "fast", provider: "a", model: "m", key: "a" },
		]);
	});

	it("fails for a provider that is not registered in Models", async () => {
		const input = table([{ alias: "fast", routes: [route("nowhere")] }]);
		expect(await issuesOf(input)).toEqual([{ _tag: "UnknownProvider", alias: "fast", provider: "nowhere" }]);
	});

	it("fails for a model its provider does not list", async () => {
		const input = table([{ alias: "fast", routes: [route("a", { model: "other" })] }]);
		expect(await issuesOf(input)).toEqual([{ _tag: "UnknownModel", alias: "fast", provider: "a", model: "other" }]);
	});

	it("reports every issue of a table at once, in table order, and says them in its message", async () => {
		const input = table(
			[
				{ alias: "fast", routes: [route("a", { ceiling: "topsecret" }), route("nowhere")] },
				{ alias: "empty", routes: [] },
			],
			{ limits: { a: { maxInFlight: 1 }, nowhere: { maxInFlight: 1 } } },
		);
		const error = await Effect.runPromise(
			Effect.flip(validateRouteTable(input)).pipe(Effect.provide(modelsLayer(scripted("a")))),
		);
		expect(error.issues.map((issue) => issue._tag)).toEqual(["UnknownCeiling", "UnknownProvider", "EmptyAlias"]);
		expect(error.message).toBe(
			'Route a/m of alias "fast" has the unknown ceiling "topsecret"; ' +
				'Alias "fast" names the provider "nowhere", which is not registered; ' +
				'Alias "empty" has no route',
		);
	});

	it("refuses a table written in code whose route has a malformed label, when the router is built", async () => {
		const input = table([{ alias: "fast", routes: [route("a", { labels: ["zero data retention"] })] }]);
		const issues = await issuesOf(input);
		expect(issues.map((issue) => issue._tag)).toEqual(["Malformed"]);
	});

	it("checks a table written in code against the schema too", async () => {
		const input = table([{ alias: "fast", routes: [route("a", { price: { ...PRICE, output: 1.5 } })] }]);
		const issues = await issuesOf(input);
		expect(issues.map((issue) => issue._tag)).toEqual(["Malformed"]);
	});
});
