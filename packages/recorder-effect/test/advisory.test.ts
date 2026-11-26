import { answer, TestHarness, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Advisory, Recorder } from "../src/index.ts";
import { App, committed, refused, type TestSink, testSink } from "./support.ts";

/** A harness whose registry ends with the recorder's extension, and a pump, both on `sink`. */
function recorded(sink: TestSink) {
	const harness = TestHarness.layer({
		extensions: [App, Advisory.extension],
		responses: [toolCall("echo", { text: "hi" }, { id: "call-1" }), answer("Said.")],
	});
	return Recorder.layer().pipe(Layer.provideMerge(harness), Layer.provide(sink.layer));
}

const run = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	const settled = yield* root.prompt("Say hi.", { requestId: "one" });
	yield* Recorder.flushAll;
	return settled;
});

describe("Advisory.extension", () => {
	it("is named recorder and holds the one hook", () => {
		expect(Advisory.extension.name).toBe("recorder");
		expect(Advisory.extension.hooks).toEqual([Advisory.hook]);
	});

	it("tells the sink of every model request before it is sent, with an id from the newest entry", async () => {
		const sink = testSink();
		await Effect.runPromise(run.pipe(Effect.provide(recorded(sink))));
		const requested = sink.stored.filter((record) => record._tag === "ModelCallRequested");
		const calls = sink.stored.filter((record) => record._tag === "ModelCall");
		expect(calls).toHaveLength(2);
		expect(requested).toEqual(
			calls.map((call, index) => ({
				_tag: "ModelCallRequested",
				id: `1:${requested[index]?.after}:requested`,
				conversation: 1,
				after: expect.any(Number),
				task: call.task,
				time: expect.any(Number),
				advisory: true,
			})),
		);
		// A request is answered by the first model call of its task whose entry is newer than `after`.
		for (const [index, call] of calls.entries()) {
			expect(requested[index]?.after).toBeLessThan(call.entry);
			expect(requested[index]?.after).toBeGreaterThan(calls[index - 1]?.entry ?? 0);
		}
		// Each notice reached the sink alone, before the batch that holds the response it announces.
		const position = (id: string | undefined) => sink.attempts.findIndex((batch) => batch.some((r) => r.id === id));
		for (const [index, call] of calls.entries()) {
			expect(sink.attempts[position(requested[index]?.id)]).toHaveLength(1);
			expect(position(requested[index]?.id)).toBeLessThan(position(call.id));
		}
	});

	it("is advisory: when the sink refuses a notice the request is sent anyway, and the notice is lost", async () => {
		const sink = testSink((_call, records) =>
			records.some((record) => record.advisory) ? Effect.fail(refused) : Effect.void,
		);
		const settled = await Effect.runPromise(run.pipe(Effect.provide(recorded(sink))));
		expect(settled.status).toBe("done");
		expect(sink.stored.filter((record) => record.advisory)).toEqual([]);
		expect(committed(sink.stored).map((record) => record._tag)).toEqual([
			"Message",
			"ModelCall",
			"ToolCallRequested",
			"ToolCallResult",
			"ModelCall",
			"Message",
		]);
		// One try per notice: the hook does not retry.
		expect(sink.attempts.filter((batch) => batch.some((record) => record.advisory))).toHaveLength(2);
	});
});
