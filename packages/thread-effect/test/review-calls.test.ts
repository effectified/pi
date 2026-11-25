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

/** The reviewer's request as the review stores it since it keeps the whole response: pi-ai's fields, as given. */
const ANSWERED = {
	provider: "reviewer-lab",
	model: "judge",
	api: "anthropic-messages",
	responseModel: "judge-2026-10-01",
	responseId: "msg_7",
	stopReason: "stop",
	timestamp: 1_699_999_998_500,
	durationMs: 1_200,
	usage: {
		input: 120,
		output: 9,
		cacheRead: 30,
		cacheWrite: 4,
		cacheWrite1h: 4,
		reasoning: 3,
		totalTokens: 163,
		cost: 0.0042,
		costs: {
			input: 0.0024,
			output: 0.0009,
			cacheRead: 0.0003,
			cacheWrite: 0.0006,
			total: 0.0042,
			totalFromProvider: true,
		},
	},
};

/** The same request as a verdict stored it before the review kept the api, the times and the parts of the cost. */
const STORED_BEFORE = {
	provider: "reviewer-lab",
	model: "judge",
	stopReason: "stop",
	usage: { input: 120, output: 9, cacheRead: 30, cacheWrite: 4, totalTokens: 163, cost: 0.0042 },
};

describe("the model call of a verdict's record", () => {
	it("is the reviewer's request in the shape of every other model call, with nothing a verdict does not hold", () => {
		expect(Option.getOrThrow(ReviewCalls.modelCall(verdict(ANSWERED)))).toEqual({
			_tag: "ModelCall",
			id: "3:21:0:model",
			conversation: 3,
			entry: 21,
			// When the request started, as in every model call record: not when the verdict was decided.
			time: 1_699_999_998_500,
			advisory: false,
			task: 20,
			provider: "reviewer-lab",
			model: "judge",
			api: "anthropic-messages",
			responseModel: "judge-2026-10-01",
			responseId: "msg_7",
			stopReason: "stop",
			error: null,
			usage: {
				input: 120,
				output: 9,
				cacheRead: 30,
				cacheWrite: 4,
				cacheWrite1h: 4,
				reasoning: 3,
				totalTokens: 163,
			},
			cost: {
				input: 0.0024,
				output: 0.0009,
				cacheRead: 0.0003,
				cacheWrite: 0.0006,
				total: 0.0042,
				fromProvider: true,
			},
			durationMs: 1_200,
			derived: { from: "3:21:entry", unknown: [] },
		});
	});

	it("gives `null` where pi-ai reported nothing, as every other model call record does, and names nothing", () => {
		const { responseModel: _model, responseId: _id, durationMs: _duration, ...bare } = ANSWERED;
		const { cacheWrite1h: _hour, reasoning: _reasoning, ...tokens } = ANSWERED.usage;
		const { totalFromProvider: _billed, ...estimated } = ANSWERED.usage.costs;
		const call = Option.getOrThrow(
			ReviewCalls.modelCall(verdict({ ...bare, usage: { ...tokens, costs: estimated } })),
		);
		expect(call).toMatchObject({
			responseModel: null,
			responseId: null,
			usage: { cacheWrite1h: null, reasoning: null },
			cost: { input: 0.0024, total: 0.0042, fromProvider: false },
			durationMs: null,
			derived: { unknown: [] },
		});
	});

	it("names what a verdict stored before the review kept the whole response lacks, and dates it by the verdict", () => {
		const call = Option.getOrThrow(ReviewCalls.modelCall(verdict(STORED_BEFORE)));
		expect(call).toMatchObject({
			time: 1_700_000_000_000,
			api: "",
			usage: { input: 120, totalTokens: 163, cacheWrite1h: null, reasoning: null },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042, fromProvider: false },
			durationMs: null,
		});
		expect(call.derived?.unknown).toEqual([
			"api",
			"cost.input",
			"cost.output",
			"cost.cacheRead",
			"cost.cacheWrite",
			"cost.fromProvider",
		]);
	});

	it("says of a request that ended without a response that its tokens and its cost are not known", () => {
		const failed = {
			provider: "router",
			model: "reviewer",
			api: "openai-responses",
			stopReason: "error",
			timestamp: 1_699_999_999_000,
			error: "The lease is fenced",
		};
		const call = Option.getOrThrow(ReviewCalls.modelCall(verdict(failed)));
		expect(call).toMatchObject({
			time: 1_699_999_999_000,
			provider: "router",
			model: "reviewer",
			api: "openai-responses",
			stopReason: "error",
			error: "The lease is fenced",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			cost: { total: 0 },
		});
		expect(call.derived?.unknown).toEqual([
			"cost.input",
			"cost.output",
			"cost.cacheRead",
			"cost.cacheWrite",
			"cost.fromProvider",
			"usage",
			"cost.total",
		]);
		// The same request as a verdict stored it before: its api is not known either.
		const { api: _api, timestamp: _timestamp, ...before } = failed;
		expect(Option.getOrThrow(ReviewCalls.modelCall(verdict(before))).derived?.unknown).toEqual([
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
