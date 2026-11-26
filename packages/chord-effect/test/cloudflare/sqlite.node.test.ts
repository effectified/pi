import type * as PiSqliteCloudflare from "@earendil-works/chord/sqlite/cloudflare";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Coverage } from "../../../../effect/conformance.ts";
import { serve } from "../fixtures/workerd.ts";

const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/sqlite/cloudflare` does with every value Chord's `/sqlite/cloudflare` exports. */
const COVERAGE = {
	DurableObjectSqliteDatabase: replaced("database: Chord's database on a Durable Object's storage, as an Effect"),
} satisfies Record<keyof typeof PiSqliteCloudflare, Coverage>;

describe("the coverage of Chord's /sqlite/cloudflare", () => {
	it("records its one value", () => {
		expect(Object.keys(COVERAGE)).toEqual(["DurableObjectSqliteDatabase"]);
	});
});

// workerd runs on Node through Miniflare; Bun runs this file too, since its runner takes every test file: skipped there.
describe.skipIf("Bun" in globalThis)("database, in workerd", () => {
	let miniflare: Miniflare;

	beforeAll(async () => {
		miniflare = await serve();
	}, 60_000);

	afterAll(() => miniflare?.dispose());

	it("is a SQLite database on the object's storage: migrated, written and read", async () => {
		const response = await miniflare.dispatchFetch("http://localhost/");
		expect(await response.json()).toEqual({ notes: [{ body: "kept" }] });
	});
});
