// Parsing a model's JSON with pi-ai's repair, as an Effect that fails with MalformedJson.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MalformedJson, parseJsonWithRepair } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

describe("parseJsonWithRepair", () => {
	it("parses JSON, and JSON with a raw newline and a stray backslash in a string", async () => {
		const values = await runTest(
			Effect.all([parseJsonWithRepair('{"a":1}'), parseJsonWithRepair('{"path":"C:\\dir","text":"a\nb"}')]),
		);
		expect(values).toEqual([{ a: 1 }, { path: "C:\\dir", text: "a\nb" }]);
	});

	it("fails with MalformedJson, carrying the text, when no repair helps", async () => {
		const failure = await runTest(Effect.flip(parseJsonWithRepair("{not json")));
		expect(failure).toBeInstanceOf(MalformedJson);
		expect(failure.text).toBe("{not json");
	});
});
