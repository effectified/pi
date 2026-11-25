// The Node entry's local engine, as far as it goes without starting one: engine.node.test.ts starts it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as LocalEngine from "../src/node.ts";

describe("the node entry", () => {
	it("says whether the engine binary is installed", () => {
		expect(typeof Effect.runSync(LocalEngine.available)).toBe("boolean");
	});

	// On Bun an assignment to `process.env` never reaches rivetkit's native core, so the entry must not start an engine.
	it.skipIf(!("Bun" in globalThis))("refuses to start an engine on Bun, with a typed error", async () => {
		const failed = await Effect.runPromise(Effect.flip(Effect.scoped(LocalEngine.serve({ actors: [] }))));
		expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "environment", retryable: false });
	});
});
