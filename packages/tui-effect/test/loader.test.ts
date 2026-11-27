import { type CancellableLoader, Text } from "@earendil-works/pi-tui";
import { Effect, Exit, Fiber, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { cancellableLoader, loader, untilCancelled } from "../src/loader.ts";
import * as Tui from "../src/tui.ts";
import { run } from "./run.ts";
import { TestTerminal } from "./terminal.ts";

const plain = (text: string): string => text;

/** Whether pi-tui's loader still has its animation timer; pi-tui keeps it in a private field. */
function animating(made: object): boolean {
	return (made as { intervalId: unknown }).intervalId !== null;
}

describe("loader", () => {
	it("shows a spinner and its message, and stops its animation when the scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const seen = await run(
			Effect.gen(function* () {
				const during = yield* Effect.scoped(
					Effect.gen(function* () {
						const made = yield* loader(plain, plain, "Working", { frames: ["*", "+"], intervalMs: 1000 });
						const tui = yield* Tui.Tui;
						tui.addChild(made);
						yield* Tui.render();
						return { made, screen: yield* terminal.screen, animating: animating(made) };
					}),
				);
				return { ...during, animatingAfter: animating(during.made) };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(seen.screen).toEqual(["", " * Working"]);
		expect([seen.animating, seen.animatingAfter]).toEqual([true, false]);
	});
});

describe("cancellableLoader and untilCancelled", () => {
	it("interrupts the work when the user cancels the focused loader", async () => {
		const terminal = new TestTerminal(40, 6);
		const exit = await run(
			Effect.gen(function* () {
				const made = yield* cancellableLoader(plain, plain, "Searching");
				yield* Tui.setFocus(made);
				const fiber = yield* Effect.forkChild(untilCancelled(Effect.never, made), { startImmediately: true });
				terminal.sendInput("\x1b");
				return yield* Fiber.await(fiber);
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(Exit.hasInterrupts(exit)).toBe(true);
	});

	it("runs the work to its end when the user does not cancel, and is interrupted at once when they already did", async () => {
		const terminal = new TestTerminal(40, 6);
		const seen = await run(
			Effect.gen(function* () {
				const made: CancellableLoader = yield* cancellableLoader(plain, plain);
				const ran = yield* Ref.make(0);
				// Data first, and in a pipe.
				const result = yield* untilCancelled(
					Effect.as(
						Ref.update(ran, (count) => count + 1),
						"done",
					),
					made,
				);
				made.handleInput("\x1b");
				const late = yield* Effect.exit(Ref.update(ran, (count) => count + 1).pipe(untilCancelled(made)));
				return { result, late: Exit.hasInterrupts(late), aborted: made.aborted, ran: yield* Ref.get(ran) };
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(seen).toEqual({ result: "done", late: true, aborted: true, ran: 1 });
	});

	it("stops the loader's animation when the scope closes", async () => {
		const terminal = new TestTerminal(40, 6);
		const made = await run(
			Effect.gen(function* () {
				const tui = yield* Tui.Tui;
				const created = yield* Effect.scoped(cancellableLoader(plain, plain, "Working"));
				tui.addChild(new Text("after"));
				return created;
			}).pipe(Effect.provide(Tui.layer({ mode: "regular", terminal }))),
		);
		expect(animating(made)).toBe(false);
	});
});
