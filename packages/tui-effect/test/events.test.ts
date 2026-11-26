import { type Editor, Input, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type EventKey, events } from "../src/events.ts";
import { run } from "./run.ts";

const selectTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

describe("events", () => {
	it("gives each value a callback is called with while the stream runs", async () => {
		const input = new Input();
		const submitted = await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(events(input, "onSubmit"), 2)), {
					startImmediately: true,
				});
				for (const key of ["h", "i", "\r", "!", "\r"]) input.handleInput(key);
				return yield* Fiber.join(fiber);
			}),
		);
		expect(submitted).toEqual(["hi", "hi!"]);
	});

	it("gives an element for a callback called with no argument", async () => {
		const items: SelectItem[] = [{ value: "a", label: "A" }];
		const list = new SelectList(items, 5, selectTheme);
		const [selected, cancelled] = await run(
			Effect.gen(function* () {
				const select = yield* Effect.forkChild(Stream.runCollect(Stream.take(events(list, "onSelect"), 1)), {
					startImmediately: true,
				});
				const cancel = yield* Effect.forkChild(Stream.runCollect(Stream.take(events(list, "onCancel"), 1)), {
					startImmediately: true,
				});
				list.handleInput("\r");
				list.handleInput("\x1b");
				return [yield* Fiber.join(select), yield* Fiber.join(cancel)];
			}),
		);
		expect(selected).toEqual([items[0]]);
		expect(cancelled).toEqual([undefined]);
	});

	it("puts the callback before back when the stream ends", async () => {
		const input = new Input();
		const before = (_value: string): void => {};
		input.onSubmit = before;
		await run(Stream.runDrain(Stream.take(events(input, "onEscape"), 0)));
		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(events(input, "onSubmit"), 1)), {
					startImmediately: true,
				});
				input.handleInput("\r");
				yield* Fiber.join(fiber);
			}),
		);
		expect(input.onSubmit).toBe(before);
	});

	it("names only the callbacks of one argument or none", () => {
		expectTypeOf<EventKey<Editor>>().toEqualTypeOf<"onSubmit" | "onChange">();
		expectTypeOf<EventKey<Input>>().toEqualTypeOf<"onSubmit" | "onEscape">();
		expectTypeOf<EventKey<SelectList>>().toEqualTypeOf<"onSelect" | "onCancel" | "onSelectionChange">();
	});
});
