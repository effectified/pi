import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ParentContext } from "../src/context.ts";

describe("ParentContext", () => {
	it("is Chord's background context unless a region sets it", () => {
		expect(Effect.runSync(Effect.service(ParentContext))).toBe(BACKGROUND_CONTEXT);
	});
});
