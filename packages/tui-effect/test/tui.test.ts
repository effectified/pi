import { Input, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";
import * as Tui from "../src/tui.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

describe("regular", () => {
	it("starts a main-screen TUI on the terminal and stops it when the scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const seen = await run(
			Effect.gen(function* () {
				const states = yield* Effect.scoped(
					Effect.gen(function* () {
						const tui = yield* Tui.regular({ terminal });
						tui.addChild(new Text("hello from pi-tui", 0, 0));
						yield* Effect.provideService(Tui.render(), Tui.Tui, tui);
						return { tui, started: terminal.started, stopped: terminal.stopped, screen: yield* terminal.screen };
					}),
				);
				return { ...states, stoppedAfter: terminal.stopped };
			}),
		);
		expect(seen.tui).toBeInstanceOf(TuiMainScreen);
		expect(seen.tui.mode).toBe("regular");
		expect([seen.started, seen.stopped, seen.stoppedAfter]).toEqual([1, 0, 1]);
		expect(seen.screen).toEqual(["hello from pi-tui"]);
	});
});

describe("fullscreen", () => {
	it("starts an alternate-screen TUI and leaves the alternate screen with the stop options when the scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const seen = await run(
			Effect.gen(function* () {
				const during = yield* Effect.scoped(
					Effect.gen(function* () {
						// Without `preserveScreen`, pi-tui prints the transcript to the main screen when it stops.
						const tui = yield* Tui.fullscreen({
							terminal,
							altScreen: { mouse: false },
							stop: { preserveScreen: true },
						});
						tui.addChild(new Text("fullscreen", 0, 0));
						yield* Effect.provideService(Tui.render(), Tui.Tui, tui);
						return { tui, screen: yield* terminal.screen };
					}),
				);
				return { ...during, after: yield* terminal.screen };
			}),
		);
		expect(seen.tui).toBeInstanceOf(TuiAltScreen);
		expect(seen.tui.mode).toBe("fullscreen");
		expect(seen.screen).toContain("fullscreen");
		expect(seen.after).not.toContain("fullscreen");
		expect(terminal.stopped).toBe(1);
	});

	it("runs a copySelection Effect for the selection copy, and reports nothing selected as false", async () => {
		const terminal = new TestTerminal(40, 6);
		const copied = await run(
			Effect.gen(function* () {
				const tui = yield* Tui.fullscreen({
					terminal,
					altScreen: { mouse: false, copySelection: () => Effect.succeed(true) },
				});
				return yield* Tui.copyActiveSelection(tui);
			}),
		);
		expect(copied).toBe(false);
	});
});

describe("layer", () => {
	it("provides the started TUI as the Tui service, in the mode asked for, and stops it with the Layer", async () => {
		const terminal = new TestTerminal(40, 6);
		const modes = await run(
			Effect.gen(function* () {
				const regular = yield* Effect.provide(
					Tui.Tui.useSync((tui) => tui.mode),
					Tui.layer({ mode: "regular", terminal }),
				);
				const fullscreen = yield* Effect.provide(
					Tui.Tui.useSync((tui) => tui.mode),
					Tui.layer({ mode: "fullscreen", terminal, altScreen: { mouse: false } }),
				);
				return [regular, fullscreen];
			}),
		);
		expect(modes).toEqual(["regular", "fullscreen"]);
		expect([terminal.started, terminal.stopped]).toEqual([2, 2]);
	});
});

describe("render and requestRender", () => {
	it("draws what changed on render, and a requested frame on the next tick", async () => {
		const terminal = new TestTerminal(40, 6);
		const screens = await run(
			Effect.gen(function* () {
				const tui = yield* Tui.Tui;
				const text = new Text("first", 0, 0);
				tui.addChild(text);
				yield* Tui.render();
				const first = yield* terminal.screen;
				text.setText("second");
				yield* Tui.render(true);
				const forced = yield* terminal.screen;
				return { first, forced, redraws: tui.fullRedraws };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(screens.first).toEqual(["first"]);
		expect(screens.forced).toEqual(["second"]);
		expect(screens.redraws).toBeGreaterThan(0);
	});

	it("requestRender asks pi-tui for a frame and returns at once", async () => {
		const terminal = new TestTerminal(40, 6);
		const rendered = await run(
			Effect.gen(function* () {
				const tui = yield* Tui.Tui;
				yield* Tui.requestRender();
				return tui.fullRedraws;
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(rendered).toBe(0);
	});
});

describe("setFocus", () => {
	it("routes the terminal's keys to the focused component", async () => {
		const terminal = new TestTerminal(40, 6);
		const value = await run(
			Effect.gen(function* () {
				const input = new Input();
				yield* Tui.setFocus(input);
				terminal.sendInput("h");
				terminal.sendInput("i");
				return input.getValue();
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(value).toBe("hi");
	});
});

describe("showOverlay", () => {
	it("shows the component above the content, focused, and hides it and gives focus back when the scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const seen = await run(
			Effect.gen(function* () {
				const tui = yield* Tui.Tui;
				const base = new Input();
				yield* Tui.setFocus(base);
				const overlay = new Input();
				const during = yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* Tui.showOverlay(overlay, { width: 10 });
						terminal.sendInput("o");
						return { focused: handle.isFocused(), shown: tui.hasOverlay() };
					}),
				);
				terminal.sendInput("b");
				return { during, shownAfter: tui.hasOverlay(), overlay: overlay.getValue(), base: base.getValue() };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(seen).toEqual({
			during: { focused: true, shown: true },
			shownAfter: false,
			overlay: "o",
			base: "b",
		});
	});
});

describe("queryColors", () => {
	it("gives the colors the terminal reports, complete at its device attributes reply", async () => {
		const terminal = new TestTerminal(40, 6);
		const colors = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Tui.queryColors("1 hour"), { startImmediately: true });
				terminal.sendInput("\x1b]10;rgb:ffff/ffff/ffff\x07");
				terminal.sendInput("\x1b]11;#000000\x07");
				terminal.sendInput("\x1b[?62;22c");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(colors).toEqual({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
			palette: undefined,
		});
	});
});

describe("the Tui module", () => {
	it("needs only a TUI: a Layer of another program's TUI drives it the same way", async () => {
		const terminal = new TestTerminal(40, 6);
		const tui = new TuiMainScreen(terminal);
		const screen = await run(
			Effect.gen(function* () {
				tui.addChild(new Text("given", 0, 0));
				yield* Tui.render();
				return yield* terminal.screen;
			}).pipe(Effect.provide(Layer.succeed(Tui.Tui, tui))),
		);
		expect(screen).toEqual(["given"]);
	});
});
