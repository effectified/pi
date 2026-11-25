import { describe, expect, it } from "vitest";
import { toMetricAttributes, toSpanAttributes } from "../src/attributes.ts";

describe("toSpanAttributes", () => {
	it("keeps every defined value and leaves undefined ones out", () => {
		expect(
			toSpanAttributes({ text: "a", count: 0, flag: false, empty: "", missing: undefined, list: ["x", "y"] }),
		).toEqual({ text: "a", count: 0, flag: false, empty: "", list: ["x", "y"] });
		expect(Object.keys(toSpanAttributes({ missing: undefined }))).toEqual([]);
		expect(toSpanAttributes(undefined)).toEqual({});
	});

	it("copies arrays, so a later change of the caller's bag is not recorded", () => {
		const tags = ["original"];
		const copy = toSpanAttributes({ tags });
		tags.push("changed");
		expect(copy).toEqual({ tags: ["original"] });
	});
});

describe("toMetricAttributes", () => {
	it("writes scalars as strings and arrays as JSON", () => {
		expect(
			toMetricAttributes({ method: "read", attempt: 2, cached: false, missing: undefined, kinds: ["a", "b"] }),
		).toEqual({ method: "read", attempt: "2", cached: "false", kinds: '["a","b"]' });
		expect(toMetricAttributes(undefined)).toEqual({});
	});
});
