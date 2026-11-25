// The outcome events as data: their ids, and their trip through JSON.

import type { SubmissionId } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Mark, OutcomeEvent } from "../src/index.ts";
import { idOf } from "../src/outcome-event.ts";

// Pi brands ids in its types only: a test names a submission by the number Pi would have given it.
const [seven, two] = [7 as SubmissionId, 2 as SubmissionId];

describe("the id of an outcome event", () => {
	it("is the thread, the submission, and for an outcome the entry and the state it rests on", () => {
		expect(idOf("thread-42", { submission: seven, entry: 0, state: "Started" })).toBe("thread-42:7:started");
		expect(idOf("thread-42", { submission: seven, entry: 31, state: "Held" })).toBe("thread-42:7:31:Held");
		// The same state of the same submission on a newer entry is another event.
		expect(idOf("thread-42", { submission: seven, entry: 44, state: "Held" })).toBe("thread-42:7:44:Held");
		// A thread's key may hold a colon itself: the parts after it are numbers and a word, read from the end.
		expect(idOf("org:7:thread", { submission: two, entry: 9, state: "Reviewed" })).toBe("org:7:thread:2:9:Reviewed");
	});

	it("names every state an event can tell, and no other", () => {
		const decode = Schema.decodeUnknownSync(Mark);
		const states = [
			"Started",
			"Reviewed",
			"Answered",
			"NotReviewed",
			"Held",
			"ReviewDeferred",
			"BudgetStopped",
			"Errored",
			"Cancelled",
		];
		for (const state of states)
			expect(decode({ submission: 1, entry: 2, state })).toEqual({ submission: 1, entry: 2, state });
		expect(() => decode({ submission: 1, entry: 2, state: "Parked" })).toThrow();
	});
});

describe("an outcome event on the wire", () => {
	it("is JSON and comes back the same, money included", () => {
		const codec = Schema.toCodecJson(OutcomeEvent);
		const events: ReadonlyArray<OutcomeEvent> = [
			{ _tag: "Started", id: "t1:7:started", thread: "t1", key: "job-1", attempt: 0 },
			{
				_tag: "Reached",
				id: "t1:7:12:Cancelled",
				thread: "t1",
				key: "job-1",
				attempt: 0,
				outcome: {
					_tag: "Cancelled",
					counts: { turns: 1, toolCalls: 0, refusedToolCalls: 0, settledMicros: 9_007_199_254_740_993n },
				},
			},
		];
		for (const event of events) {
			const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event)));
			expect(Schema.decodeUnknownSync(codec)(wire)).toEqual(event);
		}
		expect(() => Schema.decodeUnknownSync(codec)({ _tag: "Parked", id: "t1:7:parked", thread: "t1" })).toThrow();
	});
});
