import { ModelId, SessionId } from "@effectified/pi-ai";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { imposedBy } from "../src/constraint-source.ts";
import { type ConstraintRequest, ConstraintSource, ConstraintsUnavailable } from "../src/index.ts";

const REQUEST: ConstraintRequest = {
	alias: ModelId.make("author"),
	sessionId: SessionId.make("session-7"),
	metadata: { user_id: "u1" },
};

/** Asks the source of the context about `REQUEST`. */
const ask = Effect.gen(function* () {
	return yield* (yield* ConstraintSource).constraintsOf(REQUEST);
});

describe("ConstraintSource", () => {
	it("imposes nothing unless a product provides one", async () => {
		const imposed = await Effect.runPromise(ask);
		expect(imposed).toEqual({});
	});

	it("is the product's when it provides one, and is asked with what reached the router", async () => {
		const asked: ConstraintRequest[] = [];
		const imposed = await Effect.runPromise(
			ask.pipe(
				Effect.provideService(ConstraintSource, {
					constraintsOf: (request) =>
						Effect.sync(() => {
							asked.push(request);
							return { classification: "internal" };
						}),
				}),
			),
		);
		expect(imposed).toEqual({ classification: "internal" });
		expect(asked).toEqual([REQUEST]);
	});
});

describe("imposedBy", () => {
	it("gives what the source says", async () => {
		const source = { constraintsOf: () => Effect.succeed({ regions: ["eu"] }) };
		expect(await Effect.runPromise(imposedBy(source, REQUEST))).toEqual({ regions: ["eu"] });
	});

	it("fails with the source's own error when the source fails", async () => {
		const failure = new ConstraintsUnavailable({ alias: REQUEST.alias, reason: "no grant for session-7" });
		const error = await Effect.runPromise(
			Effect.flip(imposedBy({ constraintsOf: () => Effect.fail(failure) }, REQUEST)),
		);
		expect(error).toBe(failure);
	});

	it("fails with ConstraintsUnavailable, naming the defect, when the source dies or throws", async () => {
		const died = await Effect.runPromise(
			Effect.flip(imposedBy({ constraintsOf: () => Effect.die(new Error("store closed")) }, REQUEST)),
		);
		expect(died).toBeInstanceOf(ConstraintsUnavailable);
		expect(died).toMatchObject({ alias: "author", reason: "the constraint source died: store closed" });
		const threw = await Effect.runPromise(
			Effect.flip(
				imposedBy(
					{
						constraintsOf: () => {
							throw "not an error";
						},
					},
					REQUEST,
				),
			),
		);
		expect(threw).toMatchObject({ alias: "author", reason: "the constraint source died: not an error" });
	});

	it("stays interruptible: an interruption is not a refusal", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				// Started at once, it waits on the source when the fork returns.
				const fiber = yield* Effect.forkChild(imposedBy({ constraintsOf: () => Effect.never }, REQUEST), {
					startImmediately: true,
				});
				yield* Fiber.interrupt(fiber);
				return yield* Fiber.await(fiber);
			}),
		);
		expect(exit._tag).toBe("Failure");
		expect(JSON.stringify(exit)).toContain("Interrupt");
	});
});
