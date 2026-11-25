import { createHash } from "node:crypto";
import { Effect, type Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Digest } from "../src/index.ts";

describe("canonical", () => {
	it("sorts the keys of every object, keeps the order of arrays and writes no whitespace", () => {
		const value = { b: [3, { z: null, a: true }, "x"], a: { d: 1.5, c: "two" } };
		expect(Digest.canonical(value)).toBe('{"a":{"c":"two","d":1.5},"b":[3,{"a":true,"z":null},"x"]}');
	});

	it("gives one text for the same value whatever order its keys were written in", () => {
		const one = { tool: "write", options: { force: true, mode: "append" }, paths: ["a", "b"] };
		const other = { paths: ["a", "b"], options: { mode: "append", force: true }, tool: "write" };
		expect(Digest.canonical(one)).toBe(Digest.canonical(other));
		expect(Digest.canonical({ paths: ["b", "a"] })).not.toBe(Digest.canonical({ paths: ["a", "b"] }));
	});

	it("sorts keys by UTF-16 code unit and escapes as JSON does", () => {
		expect(Digest.canonical({ é: 1, z: 2, Z: 3, "10": 4, "9": 5, 'a"b': "line\nbreak" })).toBe(
			'{"10":4,"9":5,"Z":3,"a\\"b":"line\\nbreak","z":2,"é":1}',
		);
	});

	it("writes primitives as JSON, and leaves out a property that holds undefined, as JSON does", () => {
		expect([null, true, 0, -1.25, 1e21, "a"].map((value) => Digest.canonical(value))).toEqual([
			"null",
			"true",
			"0",
			"-1.25",
			"1e+21",
			'"a"',
		]);
		// Pi may hand a hook repaired arguments with such a property; the type has no word for it.
		const repaired = { text: "hi", mode: undefined } as unknown as Schema.JsonObject;
		expect(Digest.canonical(repaired)).toBe('{"text":"hi"}');
		expect(Digest.canonical({})).toBe("{}");
	});
});

describe("sha256", () => {
	it("gives the SHA-256 of the text in UTF-8 as 64 lower-case hexadecimal digits", async () => {
		expect(await Effect.runPromise(Digest.sha256("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(await Effect.runPromise(Digest.sha256("é"))).toBe(createHash("sha256").update("é", "utf8").digest("hex"));
	});
});

describe("of", () => {
	it("is the SHA-256 of the canonical JSON, so key order never changes it and a changed value does", async () => {
		const [one, other, changed] = await Effect.runPromise(
			Effect.all([
				Digest.of({ text: "hi", mode: "append" }),
				Digest.of({ mode: "append", text: "hi" }),
				Digest.of({ mode: "append", text: "hi!" }),
			]),
		);
		expect(one).toBe(createHash("sha256").update('{"mode":"append","text":"hi"}').digest("hex"));
		expect(other).toBe(one);
		expect(changed).not.toBe(one);
	});
});
