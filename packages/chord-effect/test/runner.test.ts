import { ChordError, isChordError, PluginError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, createContextKey, withContextValue } from "@earendil-works/chord/context";
import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ChordFailed, PluginFailed } from "../src/errors.ts";
import { ParentContext } from "../src/parent-context.ts";
import { runner } from "../src/runner.ts";

const run = runner(Context.empty());

describe("runner", () => {
	it("resolves with the Effect's value, under the Chord context it is given as ParentContext", async () => {
		const key = createContextKey<string>("example.caller");
		const parent = withContextValue(key, "ada", BACKGROUND_CONTEXT);
		expect(
			await run(
				Effect.map(Effect.service(ParentContext), (context) => context.value(key)),
				parent,
			),
		).toBe("ada");
	});

	it("rejects ChordFailed and PluginFailed as Chord's own errors, with their code", async () => {
		const refused = await run(
			Effect.fail(new ChordFailed({ code: "forbidden", message: "not yours" })),
			BACKGROUND_CONTEXT,
		).catch((error: unknown) => error);
		expect(isChordError(refused, "forbidden")).toBe(true);
		const over = await run(
			Effect.fail(new PluginFailed({ code: "quota", message: "over" })),
			BACKGROUND_CONTEXT,
		).catch((error: unknown) => error);
		expect(over).toBeInstanceOf(PluginError);
		expect(over).toMatchObject({ code: "quota", message: "over" });
	});

	it("rejects any other failure as an Error, and leaves Chord's own errors as they are", async () => {
		const other = await run(Effect.fail({ reason: "busy" }), BACKGROUND_CONTEXT).catch((error: unknown) => error);
		expect(other).toBeInstanceOf(Error);
		const chord = new ChordError({ code: "gone", message: "gone" });
		expect(await run(Effect.die(chord), BACKGROUND_CONTEXT).catch((error: unknown) => error)).toBe(chord);
	});

	it("interrupts the Effect when the Chord context is cancelled", async () => {
		const controller = new AbortController();
		const running = run(Effect.never, { ...BACKGROUND_CONTEXT, abortSignal: controller.signal });
		controller.abort();
		await expect(running).rejects.toBeInstanceOf(Error);
	});
});
