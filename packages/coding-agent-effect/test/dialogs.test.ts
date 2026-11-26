import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { extensionEditor, extensionInput, extensionSelector, loginDialog } from "../src/index.ts";
import { onTui, TestTerminal } from "./interactive.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

/** Whether Pi's countdown of a dialog still has its timer; Pi keeps both in private fields. */
function countingDown(dialog: object): boolean {
	const countdown = (dialog as { countdown?: { intervalId?: unknown } }).countdown;
	return countdown?.intervalId !== undefined;
}

describe("extensionInput", () => {
	it("reports the text submitted", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* extensionInput("Your name?");
				for (const key of ["A", "d", "a", ENTER]) component.handleInput(key);
				return yield* Stream.runHead(events);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toMatchObject({ value: { kind: "submit", args: ["Ada"] } });
	});

	it("counts down on Pi's timer until the scope closes", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component } = yield* Effect.scoped(
					Effect.gen(function* () {
						const made = yield* extensionInput("Your name?", undefined, { timeout: 60_000 });
						expect(countingDown(made.component)).toBe(true);
						return made;
					}),
				);
				return countingDown(component);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toBe(false);
	});
});

describe("extensionSelector", () => {
	it("reports the option chosen", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* extensionSelector("Pick one", ["red", "green"]);
				component.handleInput(DOWN);
				component.handleInput(ENTER);
				return yield* Stream.runHead(events);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toMatchObject({ value: { kind: "select", args: ["green"] } });
	});
});

describe("extensionEditor", () => {
	it("reports the user leaving the editor", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* extensionEditor("Edit the note", "draft");
				component.handleInput(ESCAPE);
				return yield* Stream.runHead(events);
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen).toMatchObject({ value: { kind: "cancel", args: [] } });
	});
});

describe("loginDialog", () => {
	it("reports a cancelled sign-in and aborts its signal", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component, events } = yield* loginDialog("faux", "Faux");
				component.handleInput(ESCAPE);
				return { event: yield* Stream.runHead(events), aborted: component.signal.aborted };
			}).pipe(Effect.provide(onTui(new TestTerminal(80, 24)))),
		);
		expect(seen.event).toMatchObject({ value: { kind: "complete", args: [false, "Login cancelled"] } });
		expect(seen.aborted).toBe(true);
	});
});
