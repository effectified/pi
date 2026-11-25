import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Exa from "../src/exa.ts";
import * as Package from "../src/index.ts";
import * as Port from "../src/provider/index.ts";

const SRC = join(import.meta.dirname, "..", "src");

/** The module specifiers a source file imports or re-exports from. */
function imports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)].map(
		(match) => match[1] ?? "",
	);
}

describe("the public surface", () => {
	it("is the port, the limits and the tools from the package entry", () => {
		expect(Object.keys(Package).sort()).toEqual([
			"Count",
			"Evidence",
			"FetchOptions",
			"Hit",
			"Limits",
			"Retrieval",
			"SearchOptions",
			"SearchProvider",
			"SearchProviderFailure",
			"SearchRateLimited",
			"SearchResponseInvalid",
			"SearchTools",
			"SearchTransportFailure",
			"SearchUnauthorized",
			"Unfetched",
			"defaultLimits",
		]);
		expect(Object.keys(Package.SearchTools).sort()).toEqual(["FETCH", "SEARCH", "extension", "fetch", "search"]);
		expect(Object.keys(Package.Evidence).sort()).toEqual(["Evidence", "ProviderRequest", "fromJson", "toJson"]);
	});

	it("gives the port alone at ./provider, with the same values as the entry", () => {
		expect(Object.keys(Port).sort()).toEqual(
			Object.keys(Package)
				.filter((name) => !["Limits", "SearchTools", "defaultLimits"].includes(name))
				.sort(),
		);
		expect(Port.SearchProvider).toBe(Package.SearchProvider);
	});

	it("gives a provider at its own subpath as `layer` and `name`", () => {
		expect(Object.keys(Exa).sort()).toEqual(["layer", "name"]);
		expect(Exa.name).toBe("exa");
	});

	it("declares each subpath in package.json, with its source", () => {
		const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
		expect(manifest.exports["./provider"].source).toBe("./src/provider/index.ts");
		expect(manifest.exports["./exa"].source).toBe("./src/exa.ts");
	});
});

describe("the port and a provider file", () => {
	it("import only effect and each other: no Pi package, no harness, no platform module", () => {
		const port = readdirSync(join(SRC, "provider")).map((name) => join(SRC, "provider", name));
		expect(port.map((file) => file.slice(SRC.length + 1)).sort()).toEqual([
			"provider/errors.ts",
			"provider/evidence.ts",
			"provider/index.ts",
			"provider/options.ts",
			"provider/retrieval.ts",
			"provider/search-provider.ts",
		]);
		for (const file of port) {
			for (const specifier of imports(file)) {
				expect(specifier === "effect" || /^\.\/[a-z-]+\.ts$/.test(specifier), `${file}: ${specifier}`).toBe(true);
			}
		}
		expect(imports(join(SRC, "exa.ts")).sort()).toEqual(["./provider/index.ts", "effect", "effect/http"]);
	});
});
