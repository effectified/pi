// The run of a test's Effect: time that stands still until the test moves it, a scope that closes with the test, and
// the failure of the Effect as the promise's rejection.

import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { runLive, runTest } from "../src/testing/index.ts";

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
	message: Schema.String,
}) {}

describe("runTest", () => {
	it("passes an hour's sleep when the test moves the clock, without waiting", async () => {
		const began = Date.now();
		const slept = await runTest(
			Effect.gen(function* () {
				const sleeping = yield* Effect.forkChild(Effect.as(Effect.sleep("1 hour"), "slept"), {
					startImmediately: true,
				});
				yield* TestClock.adjust("1 hour");
				return yield* Fiber.join(sleeping);
			}),
		);
		expect(slept).toBe("slept");
		expect(Date.now() - began).toBeLessThan(5_000);
	});

	it("runs the finalizers of the test's scope before it resolves", async () => {
		const order: Array<string> = [];
		await runTest(
			Effect.gen(function* () {
				yield* Effect.addFinalizer(() => Effect.sync(() => order.push("released")));
				order.push("ran");
			}),
		);
		expect(order).toEqual(["ran", "released"]);
	});

	it("rejects with the failure of the Effect", async () => {
		await expect(runTest(Effect.fail(Refused.make({ message: "no" })))).rejects.toThrow("no");
	});
});

describe("runLive", () => {
	it("runs on the real clock, in a scope", async () => {
		const order: Array<string> = [];
		await runLive(
			Effect.gen(function* () {
				yield* Effect.addFinalizer(() => Effect.sync(() => order.push("released")));
				yield* Effect.sleep("5 millis");
				order.push("slept");
			}),
		);
		expect(order).toEqual(["slept", "released"]);
	});
});
