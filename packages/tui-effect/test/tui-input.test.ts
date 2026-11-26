import {
	getKeybindings,
	Input,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { colorSchemes, input, presses, suspends } from "../src/tui-input.ts";
import { Tui } from "../src/tui-service.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

/** A started TUI on a test terminal, with an `Input` that has focus, as the `Tui` service. */
function focusedInput(terminal: TestTerminal, field: Input): Layer.Layer<Tui> {
	return Layer.effect(
		Tui,
		Effect.acquireRelease(
			Effect.sync(() => {
				const tui = new TuiMainScreen(terminal);
				tui.start();
				tui.setFocus(field);
				return tui;
			}),
			(tui) => Effect.sync(() => tui.stop()),
		),
	);
}

const defaults = getKeybindings();
afterEach(() => setKeybindings(defaults));

describe("input", () => {
	it("gives every input sequence while it runs, and leaves it to the focused component", async () => {
		const terminal = new TestTerminal();
		const field = new Input();
		const seen = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(input, 2)), { startImmediately: true });
				terminal.sendInput("a");
				terminal.sendInput("b");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(focusedInput(terminal, field))),
		);
		expect(seen).toEqual(["a", "b"]);
		expect(field.getValue()).toBe("ab");
	});
});

describe("presses", () => {
	it("takes the keys of the named keybindings from the focused component and gives their names", async () => {
		const terminal = new TestTerminal();
		const field = new Input();
		const seen = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					Stream.runCollect(Stream.take(presses(["tui.select.up", "tui.select.down"]), 2)),
					{ startImmediately: true },
				);
				terminal.sendInput("\x1b[B");
				terminal.sendInput("x");
				terminal.sendInput("\x1b[A");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(focusedInput(terminal, field))),
		);
		expect(seen).toEqual(["tui.select.down", "tui.select.up"]);
		expect(field.getValue()).toBe("x");
	});

	it("matches the keybindings pi-tui's components use, so a user's configuration applies", async () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n" }));
		const terminal = new TestTerminal();
		const field = new Input();
		const seen = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(presses(["tui.select.down"]), 1)), {
					startImmediately: true,
				});
				terminal.sendInput("\x1b[B");
				terminal.sendInput("\x0e");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(focusedInput(terminal, field))),
		);
		expect(seen).toEqual(["tui.select.down"]);
	});

	it("stops taking keys when the stream ends", async () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.confirm": "x" }));
		const terminal = new TestTerminal();
		const field = new Input();
		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(presses(["tui.select.confirm"]), 1)), {
					startImmediately: true,
				});
				terminal.sendInput("x");
				yield* Fiber.join(fiber);
				terminal.sendInput("x");
			}).pipe(Effect.provide(focusedInput(terminal, field))),
		);
		expect(field.getValue()).toBe("x");
	});

	it("leaves key releases to the TUI", async () => {
		const terminal = new TestTerminal();
		const field = new Input();
		const seen = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(presses(["tui.select.down"]), 1)), {
					startImmediately: true,
				});
				// The Kitty protocol's release of the down arrow, then its press.
				terminal.sendInput("\x1b[1;1:3B");
				terminal.sendInput("\x1b[B");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(focusedInput(terminal, field))),
		);
		expect(seen).toEqual(["tui.select.down"]);
	});
});

describe("colorSchemes", () => {
	it("gives each color scheme the terminal reports", async () => {
		const terminal = new TestTerminal();
		const seen = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(colorSchemes, 2)), {
					startImmediately: true,
				});
				terminal.sendInput("\x1b[?997;2n");
				terminal.sendInput("\x1b[?997;1n");
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(focusedInput(terminal, new Input()))),
		);
		expect(seen).toEqual(["light", "dark"]);
	});
});

describe("suspends", () => {
	it("gives one element per SIGTSTP while it runs, and gives the signal back when it ends", async () => {
		const terminal = new TestTerminal();
		const counts = await run(
			Effect.gen(function* () {
				const before = process.listenerCount("SIGTSTP");
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(suspends, 2)), {
					startImmediately: true,
				});
				const during = process.listenerCount("SIGTSTP");
				// `emit` calls the listeners without a real signal, so the test process is never suspended.
				process.emit("SIGTSTP");
				process.emit("SIGTSTP");
				const seen = yield* Fiber.join(fiber);
				return { seen: seen.length, added: during - before, after: process.listenerCount("SIGTSTP") - before };
			}).pipe(Effect.provide(focusedInput(terminal, new Input()))),
		);
		expect(counts).toEqual({ seen: 2, added: 1, after: 0 });
	});
});
