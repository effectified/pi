import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { KEY, Released } from "../src/hold.ts";
import { Decision, Release, ReleaseEntry } from "../src/index.ts";

describe("Decision", () => {
	const decode = Schema.decodeUnknownSync(Decision);

	it("is an acceptance, with or without a note, or a correction", () => {
		const decisions = [
			{ _tag: "Accept", by: "user:ada" },
			{ _tag: "Accept", by: "user:ada", note: "Checked by hand." },
			{ _tag: "Correct", by: "user:bob", correction: "Use the 2024 figures." },
		];
		expect(decisions.map((decision) => decode(decision))).toEqual(decisions);
	});

	it("refuses a correction without a text, and a decision by nobody", () => {
		expect(() => decode({ _tag: "Correct", by: "user:bob" })).toThrow(/correction/);
		expect(() => decode({ _tag: "Accept" })).toThrow(/by/);
	});
});

describe("the release signal and entry", () => {
	it("carry the decision under names of this package", async () => {
		const token = await Effect.runPromise(Released.token);
		expect([token.name, token.version, KEY, ReleaseEntry.kind]).toEqual([
			"review.release",
			1,
			"release",
			"review.release",
		]);
		const decision = { _tag: "Accept" as const, by: "user:ada" };
		expect(await Effect.runPromise(Released.decode(await Effect.runPromise(Released.encode(decision))))).toEqual(
			decision,
		);
		expect(Schema.decodeUnknownSync(Release)({ answer: 5, decision, time: 9 })).toEqual({
			answer: 5,
			decision,
			time: 9,
		});
		expect(() => Schema.decodeUnknownSync(Release)({ answer: 5, decision })).toThrow(/time/);
	});
});
