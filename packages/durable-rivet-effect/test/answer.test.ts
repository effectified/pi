// The answer that crosses the boundary for a call that ended with a cause.

import { Cause, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Answer, defect } from "../src/answer.ts";

describe("defect", () => {
	it("carries an Error's message", () => {
		expect(defect(Cause.die(new Error("the handler broke")))).toEqual({
			_tag: "defect",
			message: "the handler broke",
		});
	});

	it("carries anything else as text", () => {
		expect(defect(Cause.die("plain text"))).toEqual({ _tag: "defect", message: "plain text" });
	});

	it("says that the actor is stopping for an interruption", () => {
		expect(defect(Cause.interrupt())).toEqual({
			_tag: "defect",
			message: "The call was interrupted: the actor is stopping",
		});
	});
});

describe("Answer", () => {
	const decode = Schema.decodeUnknownEffect(Answer);

	it("accepts the three answers", async () => {
		const answers = [
			{ _tag: "success", value: { a: [1, null] } },
			{ _tag: "failure", error: "no" },
			{ _tag: "defect", message: "broke" },
		];
		for (const answer of answers) expect(await Effect.runPromise(decode(answer))).toEqual(answer);
	});

	it("rejects anything else an actor might reply", async () => {
		expect(await Effect.runPromise(Effect.flip(decode({ ok: true })))).toBeInstanceOf(Schema.SchemaError);
	});
});
