import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { getSuggestions } from "../src/autocomplete.ts";
import { AutocompleteError } from "../src/errors.ts";
import { run } from "./run.ts";

/** A provider that waits until its request is aborted, and records the signal it got. */
function waiting(): AutocompleteProvider & { readonly signals: AbortSignal[] } {
	const signals: AbortSignal[] = [];
	return {
		signals,
		getSuggestions: (_lines, _line, _col, { signal }) => {
			signals.push(signal);
			return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		},
		applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	};
}

describe("getSuggestions", () => {
	it("gives pi-tui's suggestions for a slash command", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "help", description: "Show help" },
				{ name: "history", description: "Show history" },
				{ name: "quit", description: "Quit" },
			],
			process.cwd(),
		);
		const suggestions = await run(getSuggestions(provider, ["/h"], 0, 2));
		expect(suggestions?.prefix).toBe("/h");
		expect(suggestions?.items.map((item) => item.value).sort()).toEqual(["help", "history"]);
	});

	it("aborts the provider's request when the fiber is interrupted", async () => {
		const provider = waiting();
		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(getSuggestions(provider, ["@src"], 0, 4, { force: true }), {
					startImmediately: true,
				});
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(provider.signals.map((signal) => signal.aborted)).toEqual([true]);
	});

	it("fails with AutocompleteError when the provider rejects", async () => {
		const provider: AutocompleteProvider = {
			getSuggestions: () => Promise.reject(new Error("fd failed")),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		const error = await run(Effect.flip(getSuggestions(provider, [""], 0, 0)));
		expect(error).toBeInstanceOf(AutocompleteError);
		expect(error.message).toBe("fd failed");
	});
});
