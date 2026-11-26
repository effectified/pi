import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { photon } from "../../src/images/index.ts";
import { png } from "./png.ts";

// Photon's WebAssembly as the installed package has it, as `/images/node` reads it.
const wasm = readFileSync(createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm"));

describe("photon", () => {
	it("scales an image to the limits, and has none for bytes that are no image", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const processor = yield* photon(wasm);
				const limits = { maxWidth: 20, maxHeight: 20, maxBytes: 100_000 };
				return {
					scaled: yield* processor.prepare(png(40, 10), "image/png", limits),
					garbage: yield* processor.prepare(new Uint8Array([1, 2, 3]), "image/png", limits),
				};
			}),
		);
		expect(Option.map(seen.scaled, (image) => [image.mimeType, image.resized])).toEqual(
			Option.some(["image/png", { from: { width: 40, height: 10 }, to: { width: 20, height: 5 } }]),
		);
		expect(seen.garbage).toEqual(Option.none());
	});
});
