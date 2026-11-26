import {
	KeybindingsManager,
	getKeybindings as piGetKeybindings,
	setKeybindings as piSetKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { getKeybindings, setKeybindings } from "../src/keybindings.ts";
import { run } from "./run.ts";

const defaults = piGetKeybindings();
afterEach(() => piSetKeybindings(defaults));

describe("getKeybindings and setKeybindings", () => {
	it("read and set the keybindings pi-tui's components match keys against", async () => {
		const configured = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" });
		const [before, after] = await run(
			Effect.gen(function* () {
				const before = yield* getKeybindings;
				yield* setKeybindings(configured);
				return [before, yield* getKeybindings];
			}),
		);
		expect(before).toBe(defaults);
		expect(after).toBe(configured);
		expect(piGetKeybindings().matches("\x13", "tui.input.submit")).toBe(true);
		expect(piGetKeybindings().matches("\r", "tui.input.submit")).toBe(false);
	});
});
