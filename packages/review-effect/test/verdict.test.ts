import type { EntryRecord } from "@earendil-works/pi-durable";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Call, Outcome, Verdict, VerdictEntry } from "../src/index.ts";
import { PARTIES } from "./scene.ts";

const STORED = {
	answer: 12,
	pass: 2,
	corrections: 1,
	...PARTIES,
	call: {
		provider: "reviewer-lab",
		model: "judge",
		stopReason: "stop",
		usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.0021 },
	},
	findings: [{ check: "review.model", severity: "block", text: "Wrong.", location: "line 2" }],
	failures: [{ check: "review.citations", error: "The index is down" }],
	outcome: { _tag: "Held", task: 31 },
	time: 1_700_000_000_000,
};

describe("Verdict", () => {
	it("is plain JSON: what is stored is what is read", () => {
		const verdict = Schema.decodeUnknownSync(Verdict)(STORED);
		expect(verdict).toEqual(STORED);
		expect(Schema.encodeSync(Verdict)(verdict)).toEqual(STORED);
	});

	it("keeps the whole of a response, and still reads a verdict stored before it kept more than one cost", () => {
		const whole = {
			...STORED,
			call: {
				...STORED.call,
				api: "anthropic-messages",
				responseModel: "judge-2026-10-01",
				responseId: "msg_7",
				timestamp: 1_699_999_998_000,
				durationMs: 1_200,
				usage: {
					...STORED.call.usage,
					cacheWrite1h: 0,
					reasoning: 12,
					costs: {
						input: 0.0012,
						output: 0.0009,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.0021,
						totalFromProvider: true,
					},
				},
			},
		};
		expect(Schema.decodeUnknownSync(Verdict)(whole)).toEqual(whole);
		// `STORED` is the shape every verdict had before: none of the new fields, and it decodes as it is.
		expect(Schema.decodeUnknownSync(Verdict)(STORED)).toEqual(STORED);
	});

	it("needs no request: a review that asked nobody has none", () => {
		const { call: _call, ...unasked } = STORED;
		expect(Schema.decodeUnknownSync(Verdict)(unasked)).toEqual(unasked);
	});

	it("keeps a failed request without usage, with its error text", () => {
		const call = { provider: "reviewer-lab", model: "judge", stopReason: "error", error: "overloaded" };
		expect(Schema.decodeUnknownSync(Call)(call)).toEqual(call);
		expect(() => Schema.decodeUnknownSync(Call)({ ...call, stopReason: "tired" })).toThrow(/stopReason/);
	});

	it("has the five outcomes, and refuses a reason it does not know", () => {
		const decode = Schema.decodeUnknownSync(Outcome);
		const outcomes = [
			{ _tag: "Passed" },
			{ _tag: "Corrected" },
			{ _tag: "Held", task: 31 },
			{ _tag: "Deferred", task: 31, attempt: 2 },
			{ _tag: "NotReviewed", reason: "same_family" },
			{ _tag: "NotReviewed", reason: "review_aborted" },
		];
		expect(outcomes.map((outcome) => decode(outcome))).toEqual(outcomes);
		expect(() => decode({ _tag: "NotReviewed", reason: "tired" })).toThrow(/reason/);
	});
});

describe("VerdictEntry", () => {
	// A stored entry as Pi returns one; its ids are branded numbers.
	const entry = (kind: string, data: unknown) => ({ id: 13, conversationId: 1, kind, data }) as unknown as EntryRecord;

	it("is the kind review.verdict, and reads only entries of that kind", async () => {
		expect(VerdictEntry.kind).toBe("review.verdict");
		const read = await Effect.runPromise(VerdictEntry.read(entry("review.verdict", STORED)));
		expect(Option.getOrThrow(read)).toMatchObject({ id: 13, kind: "review.verdict", data: STORED });
		expect(await Effect.runPromise(VerdictEntry.read(entry("app.note", STORED)))).toEqual(Option.none());
	});

	it("fails with SchemaDecodeError for a stored verdict of another shape", async () => {
		const failed = await Effect.runPromise(Effect.flip(VerdictEntry.read(entry("review.verdict", { pass: "two" }))));
		expect(failed._tag).toBe("SchemaDecodeError");
	});
});
