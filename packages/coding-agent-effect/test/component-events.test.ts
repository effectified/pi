import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { withEvents } from "../src/component-events.ts";

/** A component whose constructor takes its callbacks, as interactive mode's selectors do. */
class Picker {
	disposed = false;
	readonly onPick: (value: string, index: number) => void;
	readonly onCancel: () => void;
	constructor(onPick: (value: string, index: number) => void, onCancel: () => void) {
		this.onPick = onPick;
		this.onCancel = onCancel;
	}
}

interface PickerCallbacks {
	readonly pick: ConstructorParameters<typeof Picker>[0];
	readonly cancel: ConstructorParameters<typeof Picker>[1];
}

describe("withEvents", () => {
	it("gives each call of the callbacks, by name and arguments, in order, and ends the Stream when the scope closes", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const events = yield* Effect.scoped(
					Effect.gen(function* () {
						const made = yield* withEvents<Picker, PickerCallbacks>(
							(emit) => new Picker(emit("pick"), emit("cancel")),
						);
						made.component.onPick("red", 0);
						made.component.onCancel();
						return made.events;
					}),
				);
				// The scope closed: the Stream gives what was called, then ends.
				return yield* Stream.runCollect(events);
			}),
		);
		expect(seen).toEqual([
			{ kind: "pick", args: ["red", 0] },
			{ kind: "cancel", args: [] },
		]);
	});

	it("releases the component when the scope closes", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { component } = yield* Effect.scoped(
					withEvents<Picker, PickerCallbacks>(
						(emit) => new Picker(emit("pick"), emit("cancel")),
						(made) => {
							made.disposed = true;
						},
					),
				);
				return component.disposed;
			}),
		);
		expect(seen).toBe(true);
	});
});
