import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { settingsList } from "../src/settings-list.ts";
import { run } from "./run.ts";

const theme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: ">",
	hint: (text: string) => text,
};

describe("settingsList", () => {
	it("gives the user's changes and cancel as events, in order", async () => {
		const items = [{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] }];
		const seen = await run(
			Effect.gen(function* () {
				const { list, events } = yield* settingsList(items, 5, theme);
				const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(events, 3)), {
					startImmediately: true,
				});
				list.handleInput("\r");
				list.handleInput("\r");
				list.handleInput("\x1b");
				return yield* Fiber.join(fiber);
			}),
		);
		expect(seen).toEqual([
			{ kind: "change", id: "theme", value: "light" },
			{ kind: "change", id: "theme", value: "dark" },
			{ kind: "cancel" },
		]);
		expect(items[0]?.currentValue).toBe("dark");
	});

	it("ends its events when the scope closes", async () => {
		const seen = await run(
			Effect.gen(function* () {
				const events = yield* Effect.scoped(Effect.map(settingsList([], 5, theme), ({ events }) => events));
				return yield* Stream.runCollect(events);
			}),
		);
		expect(seen).toEqual([]);
	});
});
