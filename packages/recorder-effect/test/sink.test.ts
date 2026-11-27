import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RecordSink, RecordSinkError, Records } from "../src/index.ts";

describe("RecordSink", () => {
	it("is a service a product provides with a Layer", async () => {
		const taken: Array<ReadonlyArray<Records.Record>> = [];
		const product = Layer.succeed(RecordSink, { deliver: (records) => Effect.sync(() => void taken.push(records)) });
		const record = Schema.decodeSync(Records.Record)({
			_tag: "ModelCallRequested",
			id: "1:7:requested",
			conversation: 1,
			after: 7,
			task: 9,
			time: 1,
			advisory: true,
		});
		await Effect.runPromise(RecordSink.use((sink) => sink.deliver([record])).pipe(Effect.provide(product)));
		expect(taken).toEqual([[record]]);
	});
});

describe("RecordSinkError", () => {
	it("is a tagged error that keeps the cause and says nothing of it in its message", async () => {
		const cause = new Error("row 42 of tenant acme was rejected");
		const error = await Effect.runPromise(Effect.flip(Effect.fail(new RecordSinkError({ cause }))));
		expect(error._tag).toBe("RecordSinkError");
		expect(error.cause).toBe(cause);
		expect(error.message).toBe("The record sink failed");
	});
});
