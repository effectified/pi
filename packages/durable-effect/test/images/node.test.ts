import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { nodePhoton } from "../../src/images/node.ts";
import { png } from "./png.ts";

describe("nodePhoton", () => {
	it("prepares images with Photon read from the installed package, on the calling thread when asked", async () => {
		const prepared = await Effect.runPromise(
			Effect.flatMap(nodePhoton({ worker: false }), (processor) =>
				processor.prepare(png(8, 8), "image/png", { maxWidth: 4, maxHeight: 4, maxBytes: 100_000 }),
			),
		);
		expect(Option.map(prepared, (image) => image.resized?.to)).toEqual(Option.some({ width: 4, height: 4 }));
	});
});
