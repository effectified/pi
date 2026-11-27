import { ModelId } from "@effectified/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type Constraints, type RouteTable, resolveRoutes } from "../src/index.ts";
import { AUTHOR, route, table } from "./scripted.ts";

// Four routes: what each may see and where it runs.
const ROUTES = [
	route("open", { ceiling: "public", region: "us" }),
	route("cloud-us", { ceiling: "internal", region: "us" }),
	route("cloud-eu", { ceiling: "internal", region: "eu" }),
	route("local", { ceiling: "secret", region: "eu" }),
];

const TABLE: RouteTable = table([
	{ alias: "author", routes: ROUTES },
	{ alias: "fast", defaults: { classification: "public", regions: ["us"] }, routes: ROUTES },
]);

/** The providers of the routes that may serve `alias`, in order. */
function providers(alias: string, constraints?: Constraints): Promise<string[]> {
	return Effect.runPromise(
		Effect.map(resolveRoutes(TABLE, ModelId.make(alias), constraints), (routes) =>
			routes.map((entry) => entry.provider),
		),
	);
}

describe("resolveRoutes", () => {
	it("keeps the table's order", async () => {
		expect(await providers("author", { classification: "public" })).toEqual([
			"open",
			"cloud-us",
			"cloud-eu",
			"local",
		]);
	});

	it("never uses a route whose ceiling is below the content's classification", async () => {
		expect(await providers("author", { classification: "internal" })).toEqual(["cloud-us", "cloud-eu", "local"]);
		expect(await providers("author", { classification: "secret" })).toEqual(["local"]);
	});

	it("never uses a route whose region is not allowed", async () => {
		expect(await providers("author", { classification: "public", regions: ["eu"] })).toEqual(["cloud-eu", "local"]);
		expect(await providers("author", { classification: "public", regions: ["us", "eu"] })).toEqual([
			"open",
			"cloud-us",
			"cloud-eu",
			"local",
		]);
	});

	it("applies both filters together", async () => {
		expect(await providers("author", { classification: "internal", regions: ["us"] })).toEqual(["cloud-us"]);
	});

	it("treats content with no classification as the highest label", async () => {
		expect(await providers("author")).toEqual(["local"]);
		expect(await providers("author", { regions: ["eu"] })).toEqual(["local"]);
	});

	it("uses the alias's defaults for what the request does not say", async () => {
		expect(await providers("fast")).toEqual(["open", "cloud-us"]);
		// The request's classification wins; the default regions still apply.
		expect(await providers("fast", { classification: "internal" })).toEqual(["cloud-us"]);
		// The request's regions win; the default classification still applies.
		expect(await providers("fast", { regions: ["eu"] })).toEqual(["cloud-eu", "local"]);
	});

	it("fails with NoRouteAvailable, naming why each route is excluded, when none is left", async () => {
		const error = await Effect.runPromise(
			Effect.flip(resolveRoutes(TABLE, AUTHOR, { classification: "secret", regions: ["us"] })),
		);
		expect(error._tag).toBe("NoRouteAvailable");
		expect(error).toMatchObject({
			alias: "author",
			classification: "secret",
			regions: ["us"],
			excluded: [
				{ provider: "open", model: "m", reason: "classification" },
				{ provider: "cloud-us", model: "m", reason: "classification" },
				{ provider: "cloud-eu", model: "m", reason: "classification" },
				{ provider: "local", model: "m", reason: "region" },
			],
		});
		expect(error.message).toBe('No route of alias "author" may serve content classified "secret" in the regions us');
	});

	it("serves a request that requires labels only from a route that carries every one of them", async () => {
		const labelled: RouteTable = table([
			{
				alias: "author",
				defaults: { classification: "public" },
				routes: [
					route("plain"),
					route("zdr", { labels: ["zero-data-retention"] }),
					route("both", { labels: ["batch", "zero-data-retention"] }),
				],
			},
			{
				alias: "private",
				defaults: { classification: "public", requires: ["zero-data-retention"] },
				routes: [route("plain"), route("zdr", { labels: ["zero-data-retention"] })],
			},
		]);
		const served = (alias: string, constraints?: Constraints, imposed?: Constraints) =>
			Effect.runPromise(
				Effect.map(resolveRoutes(labelled, ModelId.make(alias), constraints, imposed), (routes) =>
					routes.map((entry) => entry.provider),
				),
			);
		expect(await served("author")).toEqual(["plain", "zdr", "both"]);
		expect(await served("author", { requires: [] })).toEqual(["plain", "zdr", "both"]);
		expect(await served("author", { requires: ["zero-data-retention"] })).toEqual(["zdr", "both"]);
		expect(await served("author", { requires: ["zero-data-retention", "batch"] })).toEqual(["both"]);
		// An alias's default labels hold for a request that names none, and a request's own replace them.
		expect(await served("private")).toEqual(["zdr"]);
		expect(await served("private", { requires: [] })).toEqual(["plain", "zdr"]);
		// What the product imposes is added to both, and nothing a request says takes it away.
		expect(await served("private", { requires: [] }, { requires: ["zero-data-retention"] })).toEqual(["zdr"]);
		expect(await served("author", { requires: ["batch"] }, { requires: ["zero-data-retention"] })).toEqual(["both"]);

		const error = await Effect.runPromise(
			Effect.flip(resolveRoutes(labelled, AUTHOR, { requires: ["batch", "byok"] }, { requires: ["batch"] })),
		);
		expect(error._tag).toBe("NoRouteAvailable");
		expect(error).toMatchObject({
			alias: "author",
			classification: "public",
			// Each required label once, the request's first.
			requires: ["batch", "byok"],
			excluded: [
				{ provider: "plain", model: "m", reason: "label", missing: ["batch", "byok"] },
				{ provider: "zdr", model: "m", reason: "label", missing: ["batch", "byok"] },
				{ provider: "both", model: "m", reason: "label", missing: ["byok"] },
			],
		});
		expect(error.message).toBe(
			'No route of alias "author" may serve content classified "public" in any region with the labels batch, byok',
		);
	});

	it("gives the first reason a route is excluded: classification, then region, then label", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				resolveRoutes(TABLE, AUTHOR, { classification: "internal", regions: ["eu"], requires: ["batch"] }),
			),
		);
		expect(error).toMatchObject({
			requires: ["batch"],
			excluded: [
				{ provider: "open", model: "m", reason: "classification" },
				{ provider: "cloud-us", model: "m", reason: "region" },
				{ provider: "cloud-eu", model: "m", reason: "label", missing: ["batch"] },
				{ provider: "local", model: "m", reason: "label", missing: ["batch"] },
			],
		});
		// The reasons that are not about labels name no label.
		expect(error._tag === "NoRouteAvailable" && error.excluded[0]).toEqual({
			provider: "open",
			model: "m",
			reason: "classification",
		});
	});

	it("lets what the product imposes only narrow: the stricter classification, the regions both allow", async () => {
		const imposed = (constraints: Constraints | undefined, product: Constraints, alias = "author") =>
			Effect.runPromise(
				Effect.map(resolveRoutes(TABLE, ModelId.make(alias), constraints, product), (routes) =>
					routes.map((entry) => entry.provider),
				),
			);
		// The stricter classification holds, whichever side names it.
		expect(await imposed({ classification: "public" }, { classification: "internal" })).toEqual([
			"cloud-us",
			"cloud-eu",
			"local",
		]);
		expect(await imposed({ classification: "secret" }, { classification: "internal" })).toEqual(["local"]);
		expect(await imposed({ classification: "internal" }, { classification: "internal" })).toEqual([
			"cloud-us",
			"cloud-eu",
			"local",
		]);
		// A classification only the product names is the content's: it is no longer the highest label by default.
		expect(await imposed(undefined, { classification: "internal" })).toEqual(["cloud-us", "cloud-eu", "local"]);
		// The alias's default is the request's when the request names none: the product's still cannot be lowered.
		expect(await imposed(undefined, { classification: "internal" }, "fast")).toEqual(["cloud-us"]);
		expect(await imposed(undefined, {}, "fast")).toEqual(["open", "cloud-us"]);
		// Regions intersect; one side alone is that side's.
		expect(await imposed({ classification: "public", regions: ["us", "eu"] }, { regions: ["eu"] })).toEqual([
			"cloud-eu",
			"local",
		]);
		expect(await imposed({ classification: "public" }, { regions: ["eu"] })).toEqual(["cloud-eu", "local"]);
		expect(await imposed({ classification: "public", regions: ["us"] }, {})).toEqual(["open", "cloud-us"]);

		// Regions that share nothing leave no route: the request does not get its own regions back.
		const none = await Effect.runPromise(
			Effect.flip(resolveRoutes(TABLE, AUTHOR, { classification: "public", regions: ["us"] }, { regions: ["eu"] })),
		);
		expect(none).toMatchObject({
			_tag: "NoRouteAvailable",
			classification: "public",
			regions: [],
			excluded: [
				{ provider: "open", model: "m", reason: "region" },
				{ provider: "cloud-us", model: "m", reason: "region" },
				{ provider: "cloud-eu", model: "m", reason: "region" },
				{ provider: "local", model: "m", reason: "region" },
			],
		});
		expect(none.message).toBe('No route of alias "author" may serve content classified "public" in no region');
	});

	it("fails with InvalidConstraints for a classification the product imposes and the table does not list", async () => {
		const error = await Effect.runPromise(
			Effect.flip(resolveRoutes(TABLE, AUTHOR, { classification: "public" }, { classification: "topsecret" })),
		);
		expect(error).toMatchObject({
			_tag: "InvalidConstraints",
			alias: "author",
			reason: '"topsecret" is not a classification of the route table',
		});
	});

	it("fails with UnknownAlias for a name the table does not have", async () => {
		const error = await Effect.runPromise(Effect.flip(resolveRoutes(TABLE, ModelId.make("nope"))));
		expect(error._tag).toBe("UnknownAlias");
		expect(error.message).toBe('The route table has no alias "nope"');
	});

	it("fails with InvalidConstraints for a classification the table does not list", async () => {
		const error = await Effect.runPromise(Effect.flip(resolveRoutes(TABLE, AUTHOR, { classification: "topsecret" })));
		expect(error._tag).toBe("InvalidConstraints");
		expect(error).toMatchObject({
			alias: "author",
			reason: '"topsecret" is not a classification of the route table',
		});
	});
});
