import { fauxAssistantMessage, runTest } from "@effectified/pi-ai/testing";
import { Text, Tui } from "@effectified/pi-tui";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentSessionRuntime, InteractiveMode } from "../src/index.ts";
import { next, openMode, openRuntime, screen, sessionEvents, TestTerminal } from "./interactive.ts";
import { services } from "./scripted.ts";

describe("InteractiveMode.make", () => {
	it("starts on the terminal, takes typed input, runs the prompt to the scripted answer and ends when the user quits", async () => {
		const terminal = new TestTerminal(80, 30);
		const seen = await runTest(
			Effect.gen(function* () {
				const { runtime, models } = yield* openRuntime();
				yield* models.setResponses([fauxAssistantMessage("The scripted answer.")]);
				const mode = yield* openMode(runtime, terminal);
				const started = terminal.started;
				const events = yield* sessionEvents(runtime);
				const run = yield* Effect.forkChild(mode.run, { startImmediately: true });
				terminal.sendInput("Hello, mode.");
				const typed = yield* screen(mode, terminal);
				terminal.sendInput("\r");
				yield* next(events, "agent_settled");
				const answered = yield* screen(mode, terminal);
				// Ctrl+D on the empty editor quits.
				terminal.sendInput("\x04");
				const ending = yield* Fiber.join(run);
				return { started, typed, answered, ending, stoppedBeforeScope: terminal.stopped };
			}).pipe(Effect.provide(services)),
		);
		expect(seen.started).toBe(1);
		expect(seen.typed.join("\n")).toContain("Hello, mode.");
		expect(seen.answered.join("\n")).toContain("Hello, mode.");
		expect(seen.answered.join("\n")).toContain("The scripted answer.");
		expect(seen.ending).toBe("quit");
		// Quitting ends the run; the scope stops the TUI (fullscreen, Pi's default, prints the transcript first).
		expect(seen.stoppedBeforeScope).toBe(0);
		expect(terminal.stopped).toBeGreaterThan(0);
	});

	it("ends the run on /quit", async () => {
		const terminal = new TestTerminal(80, 30);
		const ending = await runTest(
			Effect.gen(function* () {
				const { runtime } = yield* openRuntime();
				const mode = yield* openMode(runtime, terminal);
				const run = yield* Effect.forkChild(mode.run, { startImmediately: true });
				terminal.sendInput("/quit");
				terminal.sendInput("\r");
				return yield* Fiber.join(run);
			}).pipe(Effect.provide(services)),
		);
		expect(ending).toBe("quit");
	});

	it("stops with its scope without a quit: the TUI hands the terminal back", async () => {
		const terminal = new TestTerminal(80, 30);
		const seen = await runTest(
			Effect.gen(function* () {
				const { runtime } = yield* openRuntime();
				const during = yield* Effect.scoped(
					Effect.gen(function* () {
						const mode = yield* openMode(runtime, terminal);
						yield* Effect.forkChild(mode.run, { startImmediately: true });
						return [terminal.started, terminal.stopped];
					}),
				);
				return { during, after: [terminal.started, terminal.stopped] };
			}).pipe(Effect.provide(services)),
		);
		expect(seen.during).toEqual([1, 0]);
		expect(seen.after[1]).toBeGreaterThan(0);
	});
});

describe("InteractiveMode.layer", () => {
	it("provides the mode over the program's runtime, and its TUI as pi-tui's Tui service", async () => {
		const terminal = new TestTerminal(80, 30);
		const rows = await runTest(
			Effect.gen(function* () {
				const { runtime } = yield* openRuntime();
				return yield* Effect.gen(function* () {
					const mode = yield* InteractiveMode;
					const tui = yield* Tui.Tui;
					// An overlay of pi-tui's facade on the mode's own TUI.
					yield* Tui.showOverlay(new Text("an overlay of the program", 0, 0), { width: 40, anchor: "center" });
					return { same: tui === mode.tui, screen: yield* screen(mode, terminal) };
				}).pipe(
					Effect.provide(
						InteractiveMode.layer({ terminal }).pipe(
							Layer.provide(Layer.succeed(AgentSessionRuntime, runtime)),
							Layer.orDie,
						),
					),
					Effect.scoped,
				);
			}).pipe(Effect.provide(services)),
		);
		expect(rows.same).toBe(true);
		expect(rows.screen.join("\n")).toContain("an overlay of the program");
		expect(terminal.stopped).toBeGreaterThan(0);
	});
});
