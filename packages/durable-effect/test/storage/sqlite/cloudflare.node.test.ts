import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "../../fixtures/workerd.ts";

// workerd runs on Node through Miniflare; Bun runs this file too, since its runner takes every test file: skipped there.
describe.skipIf("Bun" in globalThis)("Pi's SQLite storage in a Durable Object, in workerd", () => {
	let miniflare: Miniflare;

	beforeAll(async () => {
		miniflare = await serve();
	}, 60_000);

	afterAll(() => miniflare?.dispose());

	it("durableObject and sqlite on its database keep what was committed, each under its prefix", async () => {
		const response = await miniflare.dispatchFetch("http://localhost/storage");
		expect(await response.json()).toEqual({ direct: { id: 1 }, chord: { id: 2 } });
	});
});
