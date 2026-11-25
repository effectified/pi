// The reviewer's request as a model call record: what `ReviewCalls.modelCall` makes of a verdict's record, and what
// the wrapped sink is given.

import { RecordSink, type Records } from "@gunta/pi-recorder-effect";
import { Effect, Layer, Option, type Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ReviewCalls } from "../src/index.ts";

/** A verdict's record as the recorder delivers it, with `call` as the reviewer's request. */
const verdict = (call: Schema.Json | undefined): Records.Entry => ({
	_tag: "Entry",
	id: "3:21:entry",
	conversation: 3,
	entry: 21,
	kind: "review.verdict",
	data: {
		answer: 19,
		pass: 1,
		corrections: 0,
		author: { provider: "author-lab", modelId: "writer", family: "alpha" },
		reviewer: { provider: "reviewer-lab", modelId: "judge", family: "beta" },
		...(call === undefined ? {} : { call }),
		findings: [],
		failures: [],
		outcome: { _tag: "Passed" },
		time: 1_700_000_000_000,
	},
	task: 20,
	time: 1_700_000_000_000,
	advisory: false,
});

const ANSWERED = {
	provider: "reviewer-lab",
	model: "judge",
	stopReason: "stop",
	usage: { input: 120, output: 9, cacheRead: 30, cacheWrite: 4, totalTokens: 163, cost: 0.0042 },
};

describe("the model call of a verdict's record", () => {
	it("is the reviewer's request in the shape of every other model call, with what a verdict does not hold named", () => {
		expect(Option.getOrThrow(ReviewCalls.modelCall(verdict(ANSWERED)))).toEqual({
			_tag: "ModelCall",
			id: "3:21:0:model",
			conversation: 3,
			entry: 21,
			time: 1_700_000_000_000,
			advisory: false,
			task: 20,
			provider: "reviewer-lab",
			model: "judge",
			api: "",
			responseModel: null,
			responseId: null,
			stopReason: "stop",
			error: null,
			usage: {
				input: 120,
				output: 9,
				cacheRead: 30,
				cacheWrite: 4,
				cacheWrite1h: null,
				reasoning: null,
				totalTokens: 163,
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042, fromProvider: false },
			durationMs: null,
			derived: {
				from: "3:21:entry",
				unknown: ["api", "cost.input", "cost.output", "cost.cacheRead", "cost.cacheWrite", "cost.fromProvider"],
			},
		});
	});

	it("says of a request that ended without a response that its tokens and its cost are not known either", () => {
		const failed = { provider: "router", model: "reviewer", stopReason: "error", error: "The lease is fenced" };
		const call = Option.getOrThrow(ReviewCalls.modelCall(verdict(failed)));
		expect(call).toMatchObject({
			provider: "router",
			model: "reviewer",
			stopReason: "error",
			error: "The lease is fenced",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			cost: { total: 0 },
		});
		expect(call.derived?.unknown).toEqual([
			"api",
			"cost.input",
			"cost.output",
			"cost.cacheRead",
			"cost.cacheWrite",
			"cost.fromProvider",
			"usage",
			"cost.total",
		]);
	});

	it("is none for a verdict without a request, for data of another shape, and for every other record", () => {
		// The family rule stopped the review before a request was sent.
		expect(ReviewCalls.modelCall(verdict(undefined))).toEqual(Option.none());
		expect(ReviewCalls.modelCall({ ...verdict(ANSWERED), data: null })).toEqual(Option.none());
		expect(ReviewCalls.modelCall({ ...verdict(ANSWERED), data: { call: { provider: 7 } } })).toEqual(Option.none());
		expect(ReviewCalls.modelCall({ ...verdict(ANSWERED), kind: "review.release" })).toEqual(Option.none());
		expect(
			ReviewCalls.modelCall({
				_tag: "ModelCallRequested",
				id: "3:20:requested",
				conversation: 3,
				after: 20,
				task: 9,
				time: 5,
				advisory: true,
			}),
		).toEqual(Option.none());
	});
});

describe("the record sink behind `ReviewCalls.layer`", () => {
	it("gets every batch as it is, with the model call of a verdict right after its record", async () => {
		const taken: Array<ReadonlyArray<Records.Record>> = [];
		const product = Layer.succeed(RecordSink, {
			deliver: (records) => Effect.sync(() => void taken.push(records)),
		});
		const note: Records.Entry = { ...verdict(undefined), id: "3:22:entry", entry: 22, kind: "app.note", data: null };
		const batch = [verdict(ANSWERED), note, verdict(undefined)];
		await Effect.runPromise(
			RecordSink.use((sink) => Effect.andThen(sink.deliver(batch), sink.deliver([]))).pipe(
				Effect.provide(Layer.provide(ReviewCalls.layer, product)),
			),
		);
		expect(taken.map((records) => records.map((record) => record.id))).toEqual([
			["3:21:entry", "3:21:0:model", "3:22:entry", "3:21:entry"],
			[],
		]);
		// The records of the batch are the values the recorder gave: nothing is rewritten.
		expect(taken[0]?.[0]).toBe(batch[0]);
		expect(taken[0]?.[2]).toBe(batch[1]);
	});
});
