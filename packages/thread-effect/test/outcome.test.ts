// The outcome and the work input as data: both cross a host boundary as JSON and come back equal.

import { LeaseFenced, ShareExhausted } from "@effectified/pi-budget";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Outcome, Threads } from "../src/index.ts";
import { work } from "./world.ts";

const counts = { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: 9_007_199_254_740_993n };

const verdict = {
	answer: 20,
	pass: 2,
	corrections: 1,
	author: { provider: "author-lab", modelId: "writer", family: "alpha" },
	reviewer: { provider: "router", modelId: "reviewer", family: "beta" },
	findings: [{ check: "review.model", severity: "block", text: "Six times seven is 42." }],
	call: {
		provider: "reviewer-lab",
		model: "judge",
		stopReason: "stop",
		usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 206, totalTokens: 222, cost: 0 },
	},
	failures: [],
	outcome: { _tag: "Passed" },
	time: 1_795_550_423_763,
};

const deferred = {
	...verdict,
	call: { provider: "router", model: "reviewer", stopReason: "error", error: "overloaded" },
	failures: [{ check: "review.model", error: "overloaded" }],
	outcome: { _tag: "Deferred", task: 31, attempt: 2 },
};

describe("the outcome of a thread", () => {
	const wire = Schema.toCodecJson(Outcome);
	const outcomes: ReadonlyArray<unknown> = [
		{ _tag: "Reviewed", counts, verdict, accepted: true },
		{ _tag: "Answered", counts },
		{ _tag: "NotReviewed", counts, reason: "same_family" },
		{ _tag: "NotReviewed", counts, reason: "check_failed", verdict },
		{ _tag: "Held", counts, verdict: { ...verdict, outcome: { _tag: "Held", task: 31 } } },
		{ _tag: "ReviewDeferred", counts, verdict: deferred, attempt: 2, reason: "overloaded" },
		{ _tag: "BudgetStopped", counts, refusal: new LeaseFenced({ reason: "expired" }) },
		{ _tag: "BudgetStopped", counts, refusal: new LeaseFenced({ reason: "expired" }), review: deferred },
		{ _tag: "BudgetStopped", counts, refusal: new ShareExhausted({ conversation: 4, cap: 400n, settled: 536n }) },
		{ _tag: "Errored", counts, reason: "model_error", detail: "invalid request" },
		{ _tag: "Errored", counts, reason: "turn_limit", detail: null },
		{ _tag: "Cancelled", counts },
	];

	for (const outcome of outcomes) {
		it(`crosses as JSON and comes back equal: ${(outcome as { readonly _tag: string })._tag}`, () => {
			const decoded = Schema.decodeUnknownSync(Outcome)(outcome);
			const json = JSON.parse(JSON.stringify(Schema.encodeSync(wire)(decoded)));
			expect(Schema.decodeUnknownSync(wire)(json)).toEqual(decoded);
		});
	}

	it("keeps money past the safe integers, as a string on the wire", () => {
		const decoded = Schema.decodeUnknownSync(Outcome)({ _tag: "Cancelled", counts });
		expect(Schema.encodeSync(wire)(decoded)).toEqual({
			_tag: "Cancelled",
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: "9007199254740993" },
		});
	});
});

describe("the work input of a thread", () => {
	it("crosses as JSON and comes back equal", () => {
		const wire = Schema.toCodecJson(Threads.Work);
		const input = {
			...work("t1", "Say hi."),
			review: false,
			routing: { regions: ["eu"], requires: ["no-retention"] },
			instructions: "Be brief.",
			maxTurns: 4,
		};
		const json = JSON.parse(JSON.stringify(Schema.encodeSync(wire)(input)));
		expect(json).toMatchObject({
			thread: "t1",
			cap: "1000000",
			grant: { tools: ["lookup"], classification: "internal" },
			review: false,
			routing: { regions: ["eu"], requires: ["no-retention"] },
		});
		expect(Schema.decodeUnknownSync(wire)(json)).toEqual(input);
	});
});
