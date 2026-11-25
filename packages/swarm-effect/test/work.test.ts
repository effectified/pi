import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidValue } from "../src/errors.ts";
import { compile } from "../src/work.ts";

const work = compile({
	name: "count",
	input: Schema.Struct({ word: Schema.String, since: Schema.DateTimeUtcFromString }),
	result: Schema.Struct({ letters: Schema.Finite, vowels: Schema.Finite }),
	prompt: ({ word, since }, job) => `Count ${word} for ${job.key} of ${job.swarmId}, since ${since.pipe(String)}.`,
});

const run = Effect.runPromise;
const job = { swarmId: "s", key: "k" };

describe("compile", () => {
	it("keeps the name, and gives two corrections unless the definition says otherwise", () => {
		expect([work.name, work.corrections]).toEqual(["count", 2]);
		const strict = compile({
			name: "n",
			input: Schema.String,
			result: Schema.String,
			prompt: String,
			corrections: 0,
		});
		expect(strict.corrections).toBe(0);
	});

	it("stores a job input as the JSON its schema encodes to, and builds the prompt from the decoded value", async () => {
		const stored = await run(
			work.encodeInput({
				word: "tea",
				since: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)("2026-01-02T00:00:00Z"),
			}),
		);
		expect(stored).toEqual({ word: "tea", since: "2026-01-02T00:00:00.000Z" });
		const prompt = await run(work.promptOf(stored, job));
		expect(prompt.startsWith("Count tea for k of s, since ")).toBe(true);
		// How to answer follows the product's own words, with the JSON Schema of the result.
		expect(prompt).toContain("\n\nAnswer with one JSON value and nothing else: no prose and no code fence.");
		expect(prompt).toContain('"required":["letters","vowels"]');
	});

	it("fails with InvalidValue for a stored input that is not the schema's", async () => {
		const error = await run(Effect.flip(work.promptOf({ word: 3 }, job)));
		expect(error).toBeInstanceOf(InvalidValue);
		expect(error.what).toBe("input");
		expect(error.issues).toContain('["word"]');
	});
});

describe("read", () => {
	it("gives the stored JSON of an answer that decodes, wherever the JSON sits in it", async () => {
		expect(await run(work.read('{"letters":3,"vowels":2}'))).toEqual({ letters: 3, vowels: 2 });
		expect(await run(work.read('Sure:\n```json\n{"letters":3,"vowels":2}\n```'))).toEqual({ letters: 3, vowels: 2 });
		expect(await run(work.decodeResult({ letters: 3, vowels: 2 }))).toEqual({ letters: 3, vowels: 2 });
	});

	it("refuses an answer without JSON", async () => {
		const refused = await run(Effect.flip(work.read("Three letters.")));
		expect(refused).toEqual(new InvalidValue({ what: "result", issues: "The answer holds no JSON value" }));
	});

	it("refuses JSON off the schema with every issue at once, and words the correction from them", async () => {
		const refused = await run(Effect.flip(work.read('{"letters":"three"}')));
		expect(refused.what).toBe("result");
		expect(refused.issues).toContain('["letters"]');
		expect(refused.issues).toContain('["vowels"]');
		expect(work.correctionOf(refused)).toBe(
			`Your last answer was not accepted:\n${refused.issues}\nAnswer again with one corrected JSON value and nothing else.`,
		);
	});
});
