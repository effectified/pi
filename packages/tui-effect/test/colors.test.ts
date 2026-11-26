import { indexedColor, rgbColor } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseColor } from "../src/colors.ts";
import { InvalidColor } from "../src/errors.ts";
import { run } from "./run.ts";

describe("parseColor", () => {
	it("gives the color a palette index or a hex color names", async () => {
		const colors = await run(Effect.all([parseColor(42), parseColor("#ff8000"), parseColor("#fff")]));
		expect(colors).toEqual([indexedColor(42), rgbColor(255, 128, 0), rgbColor(255, 255, 255)]);
	});

	it("fails with InvalidColor for a value pi-tui cannot parse or that is out of range", async () => {
		const failures = await run(
			Effect.all([Effect.flip(parseColor("blurple")), Effect.flip(parseColor(300)), Effect.flip(parseColor("#12"))]),
		);
		expect(failures.every((failure) => failure instanceof InvalidColor)).toBe(true);
		expect(failures.map((failure) => failure.value)).toEqual(["blurple", 300, "#12"]);
		expect(failures[0]?.message).toBe("Invalid color value: blurple");
	});
});
