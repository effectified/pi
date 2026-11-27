import type { TaskId } from "@earendil-works/pi-durable";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Copy from "../src/copy.ts";

describe("the mark of a copied storage", () => {
	it("covers the tasks up to the one it was written at, and none without a mark", () => {
		const mark = Option.some({ through: 7 as TaskId });
		expect([6, 7, 8].map((id) => Copy.covers(mark, id as TaskId))).toEqual([true, true, false]);
		expect(Copy.covers(Option.none(), 1 as TaskId)).toBe(false);
	});

	it("is a document of this package, and its reason is the word a child's document carries", () => {
		expect([Copy.Document.kind, Copy.REASON]).toEqual(["subagent.copy", "copied"]);
	});
});
