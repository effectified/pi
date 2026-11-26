import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { convertToPng, detectSupportedImageMimeTypeFromFile, formatDimensionNote, resizeImage } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

/** A PNG of one pixel. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const bytes = () => Uint8Array.from(atob(PIXEL), (char) => char.charCodeAt(0));

describe("detectSupportedImageMimeTypeFromFile", () => {
	it("recognizes an image a model can take from the file's first bytes", async () => {
		const type = await runLive(
			Effect.gen(function* () {
				const file = join(yield* tempDir, "pixel");
				writeFileSync(file, bytes());
				return yield* detectSupportedImageMimeTypeFromFile(file);
			}),
		);
		expect(type).toBe("image/png");
	});
});

describe("convertToPng", () => {
	it("gives an image as PNG", async () => {
		const png = await runLive(convertToPng(PIXEL, "image/png"));
		expect(png?.mimeType).toBe("image/png");
	});
});

describe("resizeImage", () => {
	it("keeps an image within Pi's limits as it is, and says so", async () => {
		const resized = await runLive(resizeImage(bytes(), "image/png"));
		expect(resized).toMatchObject({ width: 1, height: 1, wasResized: false });
		expect(resized && formatDimensionNote(resized)).toBeUndefined();
	});
});
