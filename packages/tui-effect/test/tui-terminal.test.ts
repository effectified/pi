import { isAppleTerminalSession as piIsAppleTerminalSession } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as Tui from "../src/tui.ts";
import { drainInput, isAppleTerminalSession, progress, setProgramStatus, setTitle } from "../src/tui-terminal.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

describe("setTitle and setProgramStatus", () => {
	it("hand the title and the status to the TUI's terminal", async () => {
		const terminal = new TestTerminal();
		await run(
			Effect.gen(function* () {
				yield* setTitle("pi");
				yield* setProgramStatus({ state: "working" });
				yield* setProgramStatus({ state: "clear" });
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(terminal.titles).toEqual(["pi"]);
		expect(terminal.statuses).toEqual([{ state: "working" }, { state: "clear" }]);
	});
});

describe("progress", () => {
	it("shows the busy indicator until its scope closes", async () => {
		const terminal = new TestTerminal();
		const during = await run(
			Effect.gen(function* () {
				const shown = yield* Effect.scoped(
					Effect.andThen(
						progress,
						Effect.sync(() => [...terminal.progress]),
					),
				);
				return { shown, after: [...terminal.progress] };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(during).toEqual({ shown: [true], after: [true, false] });
	});
});

describe("drainInput", () => {
	it("completes once the terminal drained its input", async () => {
		const terminal = new TestTerminal();
		const drained = await run(
			Effect.as(drainInput({ maxMs: 10, idleMs: 1 }), "drained").pipe(
				Effect.provide(Tui.layer({ mode: "regular", terminal })),
			),
		);
		expect(drained).toBe("drained");
	});
});

describe("isAppleTerminalSession", () => {
	it("is pi-tui's answer for this process", async () => {
		expect(await run(isAppleTerminalSession)).toBe(piIsAppleTerminalSession());
	});
});
