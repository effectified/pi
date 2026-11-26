import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Tui } from "../src/tui-service.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

describe("Tui", () => {
	it("holds pi-tui's own object, so what takes a TUI takes it", async () => {
		const tui = new TuiMainScreen(new TestTerminal());
		const text = new Text("x");
		const held = await run(
			Effect.gen(function* () {
				const service = yield* Tui;
				service.addChild(text);
				return service;
			}).pipe(Effect.provide(Layer.succeed(Tui, tui))),
		);
		expect(held).toBe(tui);
		expect(tui.children).toEqual([text]);
	});
});
