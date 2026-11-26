import { Image, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { allocateImageId, setImageTranscoder } from "../src/images.ts";
import { run } from "./run.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const theme = { fallbackColor: (text: string) => text };

afterEach(async () => {
	await run(setImageTranscoder(undefined));
	resetCapabilitiesCache();
});

describe("setImageTranscoder", () => {
	it("sets the converter a non-PNG image is drawn with on a Kitty terminal, and removes it", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const converted: string[] = [];
		const [withConverter, without] = await run(
			Effect.gen(function* () {
				yield* setImageTranscoder((data, mimeType) => {
					converted.push(`${mimeType}:${data}`);
					return PNG;
				});
				const drawn = new Image("anVzdCBieXRlcw==", "image/jpeg", theme).render(40);
				yield* setImageTranscoder(undefined);
				return [drawn, new Image("b3RoZXIgYnl0ZXM=", "image/jpeg", theme).render(40)];
			}),
		);
		expect(converted).toEqual(["image/jpeg:anVzdCBieXRlcw=="]);
		expect(withConverter[0]?.startsWith("\x1b_G")).toBe(true);
		expect(without).toEqual([expect.stringContaining("image/jpeg")]);
	});
});

describe("allocateImageId", () => {
	it("gives a Kitty image id: a positive 32-bit integer", async () => {
		const ids = await run(Effect.all([allocateImageId, allocateImageId]));
		for (const id of ids) {
			expect(Number.isInteger(id) && id >= 1 && id <= 0xffffffff).toBe(true);
		}
	});
});
