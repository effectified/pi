// Conditions on a fake's state: a wait that ends when the fake says its state changed so that the condition holds.

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { conditions, runTest } from "../src/testing/index.ts";

describe("conditions", () => {
	it("succeeds at once for a condition that holds", () =>
		runTest(
			Effect.gen(function* () {
				const { when } = conditions();
				yield* when(() => true);
			}),
		));

	it("waits until a change makes the condition hold, and not at a change that does not", () =>
		runTest(
			Effect.gen(function* () {
				const seen: Array<string> = [];
				const { when, changed } = conditions();
				const waiting = yield* Effect.forkChild(
					when(() => seen.length === 2),
					{ startImmediately: true },
				);
				seen.push("a");
				changed();
				yield* Effect.yieldNow;
				const early = waiting.pollUnsafe();
				seen.push("b");
				changed();
				yield* Fiber.join(waiting);
				expect(early).toBeUndefined();
			}),
		));

	it("lets a wait be interrupted, and a later change then asks only the waits that remain", () =>
		runTest(
			Effect.gen(function* () {
				let state = 0;
				let asked = 0;
				const { when, changed } = conditions();
				const given = yield* Effect.forkChild(
					when(() => {
						asked += 1;
						return state === 1;
					}),
					{ startImmediately: true },
				);
				yield* Fiber.interrupt(given);
				const kept = yield* Effect.forkChild(
					when(() => state === 2),
					{ startImmediately: true },
				);
				const before = asked;
				state = 2;
				changed();
				yield* Fiber.join(kept);
				expect(asked).toBe(before);
			}),
		));
});
