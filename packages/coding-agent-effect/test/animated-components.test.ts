import { runTest } from "@effectified/pi-ai/testing";
import { Tui } from "@effectified/pi-tui";
import { Effect, type Scope } from "effect";
import { describe, expect, it } from "vitest";
import { armin, bashExecution, borderedLoader, type Theme } from "../src/index.ts";
import { onTui, TestTerminal } from "./interactive.ts";

/** Whether a pi-tui loader still has its animation timer; pi-tui keeps it in a private field. */
function spinning(loader: unknown): boolean {
	return (loader as { intervalId: unknown }).intervalId !== null;
}

/** The loader inside one of Pi's components, kept in its private `loader` field. */
function loaderOf(component: object): unknown {
	return (component as { loader: unknown }).loader;
}

/** A theme that styles nothing: the bordered loader only asks a theme for foreground colors. */
const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

/** `make`'s component, and whether its timer runs inside its scope and after it closes. */
function timerAcrossScope<A extends object>(
	make: Effect.Effect<A, never, Tui.Tui | Scope.Scope>,
	running: (component: A) => boolean,
) {
	return Effect.gen(function* () {
		const component = yield* Effect.scoped(
			Effect.gen(function* () {
				const made = yield* make;
				expect(running(made)).toBe(true);
				return made;
			}),
		);
		return running(component);
	});
}

describe("armin", () => {
	it("animates until the scope closes", async () => {
		const after = await runTest(
			timerAcrossScope(armin, (made) => (made as unknown as { interval: unknown }).interval !== null).pipe(
				Effect.provide(onTui(new TestTerminal(80, 40))),
			),
		);
		expect(after).toBe(false);
	});
});

describe("borderedLoader", () => {
	it("shows its message between borders and stops its spinner when the scope closes", async () => {
		const terminal = new TestTerminal(60, 10);
		const seen = await runTest(
			Effect.gen(function* () {
				let screen: string[] = [];
				const after = yield* timerAcrossScope(
					borderedLoader(plainTheme, "Fetching the catalog").pipe(
						Effect.tap((made) =>
							Effect.gen(function* () {
								(yield* Tui.Tui).addChild(made);
								yield* Tui.render();
								screen = yield* terminal.screen;
							}),
						),
					),
					(made) => spinning(loaderOf(made)),
				);
				return { after, screen: screen.join("\n") };
			}).pipe(Effect.provide(onTui(terminal))),
		);
		expect(seen.screen).toContain("Fetching the catalog");
		expect(seen.after).toBe(false);
	});
});

describe("bashExecution", () => {
	it("spins while the command runs, until the scope closes", async () => {
		const after = await runTest(
			timerAcrossScope(bashExecution("ls"), (made) => spinning(loaderOf(made))).pipe(
				Effect.provide(onTui(new TestTerminal(80, 24))),
			),
		);
		expect(after).toBe(false);
	});
});
