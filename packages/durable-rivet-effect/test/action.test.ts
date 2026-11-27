// An action on both sides of the boundary, without an engine: what `run` answers inside the actor, and what the
// caller's codecs make of it.

import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Action from "../src/action.ts";

class TooLate extends Schema.TaggedError<TooLate, { readonly brand: unique symbol }>()("TooLate", {
	by: Schema.Number,
}) {}

class Calendar extends Context.Service<Calendar, { readonly today: Date }>()("test/Calendar") {}

/** Days from the calendar's today to `at`; a date in the past is the action's own failure. */
const daysUntil = Action.make({
	input: Schema.Struct({ at: Schema.Date }),
	output: Schema.Struct({ days: Schema.Number, at: Schema.Date }),
	error: TooLate,
	handler: ({ at }) =>
		Effect.gen(function* () {
			const { today } = yield* Calendar;
			const days = Math.round((at.getTime() - today.getTime()) / 86_400_000);
			if (days < 0) return yield* new TooLate({ by: -days });
			return { days, at };
		}),
});

const run = (encoded: unknown) =>
	Effect.runPromise(
		Effect.provideService(daysUntil.run(encoded), Calendar, { today: new Date("2026-11-25T00:00:00.000Z") }),
	);

describe("Action.make", () => {
	it("decodes the JSON input, runs the handler with its services, and answers the encoded value", async () => {
		expect(await run({ at: "2026-11-28T00:00:00.000Z" })).toEqual({
			_tag: "success",
			value: { days: 3, at: "2026-11-28T00:00:00.000Z" },
		});
	});

	it("answers the handler's own failure, encoded with the error schema", async () => {
		expect(await run({ at: "2026-11-23T00:00:00.000Z" })).toEqual({
			_tag: "failure",
			error: { _tag: "TooLate", by: 2 },
		});
	});

	it("answers a defect for an input its schema rejects, without running the handler", async () => {
		const answer = await run({ at: 5 });
		expect(answer._tag).toBe("defect");
		expect(answer).toMatchObject({ message: expect.stringContaining('["at"]') });
	});

	it("answers a defect with its message when the handler dies", async () => {
		const broken = Action.make({
			input: Schema.Null,
			output: Schema.Null,
			handler: () => Effect.die(new Error("the handler broke")),
		});
		expect(await Effect.runPromise(broken.run(null))).toEqual({ _tag: "defect", message: "the handler broke" });
	});

	it("answers a defect for a value its output schema cannot encode", async () => {
		const wrong = Action.make({
			input: Schema.Null,
			output: Schema.Struct({ at: Schema.Date }),
			handler: () => Effect.succeed({ at: new Date(Number.NaN) }),
		});
		expect((await Effect.runPromise(wrong.run(null)))._tag).toBe("defect");
	});
});

describe("Action.boundary", () => {
	it("encodes an input as the JSON the action decodes, and decodes what the action answers", async () => {
		const at = new Date("2026-11-28T00:00:00.000Z");
		expect(await Effect.runPromise(daysUntil.encodeInput({ at }))).toEqual({ at: "2026-11-28T00:00:00.000Z" });
		expect(await Effect.runPromise(daysUntil.decodeOutput({ days: 3, at: "2026-11-28T00:00:00.000Z" }))).toEqual({
			days: 3,
			at,
		});
		expect(await Effect.runPromise(daysUntil.decodeError({ _tag: "TooLate", by: 2 }))).toEqual(
			new TooLate({ by: 2 }),
		);
	});

	it("fails with the schema's error for a value outside it", async () => {
		const failed = await Effect.runPromise(Effect.flip(daysUntil.decodeOutput({ days: "three" })));
		expect(failed).toBeInstanceOf(Schema.SchemaError);
	});

	it("gives an action without an error schema one that nothing matches", async () => {
		const plain = Action.boundary({ input: Schema.Null, output: Schema.Null });
		expect(plain.error).toBe(Schema.Never);
		expect(await Effect.runPromise(Effect.flip(plain.decodeError("anything")))).toBeInstanceOf(Schema.SchemaError);
	});
});
