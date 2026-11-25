import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { correction, instruction, jsonOf } from "../src/answer.ts";

describe("jsonOf", () => {
	it("reads an answer that is JSON as a whole, whatever the value", () => {
		expect(jsonOf(' {"word":"a","length":1}\n')).toEqual(Option.some({ word: "a", length: 1 }));
		expect(jsonOf("[1,2]")).toEqual(Option.some([1, 2]));
		expect(jsonOf('"yes"')).toEqual(Option.some("yes"));
		expect(jsonOf("42")).toEqual(Option.some(42));
	});

	it("reads the last fenced block that parses", () => {
		const text = 'First try:\n```json\n{"length": 1}\n```\nBetter:\n```\n{"length": 2}\n```\nDone.';
		expect(jsonOf(text)).toEqual(Option.some({ length: 2 }));
		expect(jsonOf('```json\n{"length": 1}\n```\n```\nnot json\n```')).toEqual(Option.some({ length: 1 }));
	});

	it("reads the value between the first and the last brace, or bracket, of prose", () => {
		expect(jsonOf('Here it is: {"word":"a","nested":{"n":1}} I hope it helps.')).toEqual(
			Option.some({ word: "a", nested: { n: 1 } }),
		);
		expect(jsonOf("The list is [1, 2, 3].")).toEqual(Option.some([1, 2, 3]));
	});

	it("is none for an answer without JSON", () => {
		expect(jsonOf("It has one letter.")).toEqual(Option.none());
		expect(jsonOf("")).toEqual(Option.none());
		expect(jsonOf("} wrong way round {")).toEqual(Option.none());
	});
});

describe("the words to a fork", () => {
	it("ask for one JSON value, with the JSON Schema when there is one", () => {
		expect(instruction(Option.none())).toBe(
			"Answer with one JSON value and nothing else: no prose and no code fence.",
		);
		expect(instruction(Option.some('{"type":"string"}'))).toBe(
			'Answer with one JSON value and nothing else: no prose and no code fence. It must match this JSON Schema:\n{"type":"string"}',
		);
	});

	it("say what was wrong with an answer, and to answer again", () => {
		expect(correction('Missing key at ["length"]')).toBe(
			'Your last answer was not accepted:\nMissing key at ["length"]\nAnswer again with one corrected JSON value and nothing else.',
		);
	});
});
