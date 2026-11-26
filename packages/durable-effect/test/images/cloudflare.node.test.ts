/// <reference path="../../../durable/src/images/photon-wasm.d.ts" />
// Pi's `/images/cloudflare` imports Photon's WebAssembly as a module only Wrangler provides; the reference above
// declares it for the type check, as pi-durable's own build does.

import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "../fixtures/workerd.ts";
import { png } from "./png.ts";

// workerd runs on Node through Miniflare; Bun runs this file too, since its runner takes every test file: skipped there.
describe.skipIf("Bun" in globalThis)("cloudflarePhoton, in workerd", () => {
	let miniflare: Miniflare;

	beforeAll(async () => {
		miniflare = await serve();
	}, 60_000);

	afterAll(() => miniflare?.dispose());

	it("prepares an image with Photon on Wrangler's compiled module", async () => {
		const response = await miniflare.dispatchFetch("http://localhost/images", { method: "POST", body: png(40, 10) });
		expect(await response.json()).toEqual({
			mimeType: "image/png",
			resized: { from: { width: 40, height: 10 }, to: { width: 20, height: 5 } },
		});
	});
});
