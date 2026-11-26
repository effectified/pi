import { getCapabilities as piGetCapabilities, type TerminalCapabilities } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectCapabilities,
	getCapabilities,
	getCellDimensions,
	getTerminalColorMode,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
} from "../src/capabilities.ts";
import { run } from "./run.ts";

const KITTY: TerminalCapabilities = { images: "kitty", trueColor: true, hyperlinks: true };

afterEach(() => run(Effect.andThen(setCapabilityOverrides({}), resetCapabilitiesCache)));

describe("getCapabilities, setCapabilities and resetCapabilitiesCache", () => {
	it("read and replace the cached capabilities, and detect them again after a reset", async () => {
		const seen = await run(
			Effect.gen(function* () {
				yield* setCapabilities(KITTY);
				const set = yield* getCapabilities;
				yield* resetCapabilitiesCache;
				return { set, detected: yield* getCapabilities, fresh: yield* detectCapabilities };
			}),
		);
		expect(seen.set).toEqual(KITTY);
		expect(seen.detected).toEqual(seen.fresh);
		expect(seen.detected).toEqual(piGetCapabilities());
	});
});

describe("setCapabilityOverrides", () => {
	it("overrides the detected capabilities it names", async () => {
		const capabilities = await run(
			Effect.andThen(setCapabilityOverrides({ images: null, trueColor: false }), getCapabilities),
		);
		expect(capabilities).toMatchObject({ images: null, trueColor: false });
	});
});

describe("getTerminalColorMode", () => {
	it("is truecolor for capabilities with true color, and 256color without", async () => {
		const modes = await run(
			Effect.all([getTerminalColorMode(KITTY), getTerminalColorMode({ ...KITTY, trueColor: false })]),
		);
		expect(modes).toEqual(["truecolor", "256color"]);
	});

	it("reads the cached capabilities when given none", async () => {
		const mode = await run(Effect.andThen(setCapabilities({ ...KITTY, trueColor: false }), getTerminalColorMode()));
		expect(mode).toBe("256color");
	});
});

describe("getCellDimensions and setCellDimensions", () => {
	it("read and set the size of one cell", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const before = yield* getCellDimensions;
				yield* setCellDimensions({ widthPx: 10, heightPx: 20 });
				const set = yield* getCellDimensions;
				yield* setCellDimensions(before);
				return set;
			}),
		);
		expect(seen).toEqual({ widthPx: 10, heightPx: 20 });
	});
});
