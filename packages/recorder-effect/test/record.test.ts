import { answer, TestHarness, toolCall } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Advisory, Recorder, Records } from "../src/index.ts";
import { App, testSink } from "./support.ts";

const decode = Schema.decodeUnknownSync(Records.Record);

describe("Records.Record", () => {
	it("holds every record a run delivers, and each is the same value after a trip through JSON", async () => {
		const sink = testSink();
		await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("Try.", { requestId: "one" });
				yield* Recorder.flushAll;
			}).pipe(
				Effect.provide(
					Recorder.layer().pipe(
						Layer.provideMerge(
							TestHarness.layer({
								extensions: [App, Advisory.extension],
								responses: [toolCall("fails", {}, { id: "call-f" }), answer("It failed.")],
							}),
						),
						Layer.provide(sink.layer),
					),
				),
			),
		);
		expect(new Set(sink.stored.map((record) => record._tag))).toEqual(
			new Set(["Message", "ModelCall", "ToolCallRequested", "ToolCallResult", "ModelCallRequested"]),
		);
		for (const record of sink.stored) expect(decode(JSON.parse(JSON.stringify(record)))).toEqual(record);
		// No record of the recorder's own says that it was derived by a host.
		expect(sink.stored.filter((record) => record._tag === "ModelCall" && record.derived !== undefined)).toEqual([]);
	});

	it("holds a model call a host derived from a plugin's entry, with the fields that entry does not hold", () => {
		const call = {
			_tag: "ModelCall",
			id: "1:21:0:model",
			conversation: 1,
			entry: 21,
			time: 5,
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
				input: 7,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cacheWrite1h: null,
				reasoning: null,
				totalTokens: 10,
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01, fromProvider: false },
			durationMs: null,
			derived: { from: "1:21:entry", unknown: ["api", "cost.input"] },
		};
		expect(decode(JSON.parse(JSON.stringify(call)))).toEqual(call);
		// The field is optional, and its two parts come together.
		const { derived: _derived, ...plain } = call;
		expect(decode(plain)).toEqual(plain);
		expect(() => decode({ ...call, derived: { from: "1:21:entry" } })).toThrow();
	});

	it("holds the record of an entry without a model message, with or without data and time", () => {
		const entry = {
			_tag: "Entry",
			id: "1:21:entry",
			conversation: 1,
			entry: 21,
			kind: "review.verdict",
			data: { outcome: { _tag: "Passed" }, findings: [], time: 5 },
			task: 20,
			time: 5,
			advisory: false,
		};
		expect(decode(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
		const bare = { ...entry, data: null, task: null, time: null };
		expect(decode(JSON.parse(JSON.stringify(bare)))).toEqual(bare);
		expect(() => decode({ ...entry, advisory: true })).toThrow();
		expect(() => decode({ ...entry, kind: undefined })).toThrow();
	});

	it("rejects a value of no record kind, and a record without its id", () => {
		expect(() => decode({ _tag: "Note", id: "1:2:0:note" })).toThrow();
		expect(() =>
			decode({ _tag: "ModelCallRequested", conversation: 1, after: 0, task: 2, time: 3, advisory: true }),
		).toThrow();
	});

	it("tells committed records from advisory ones by the `advisory` field", () => {
		const advisory = decode({
			_tag: "ModelCallRequested",
			id: "1:7:requested",
			conversation: 1,
			after: 7,
			task: 9,
			time: 5,
			advisory: true,
		});
		expect(advisory.advisory).toBe(true);
		// A record derived from an entry never claims to be advisory, and the other way round.
		expect(() => decode({ ...advisory, advisory: false })).toThrow();
	});
});
