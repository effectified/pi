import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Latch } from "effect";
import { describe, expect, it } from "vitest";
import { untilSettled } from "../src/settled.ts";

describe("untilSettled", () => {
	it("succeeds with the promise's value, and fails with what `rejected` makes of its rejection", async () => {
		const exits = await runTest(
			Effect.gen(function* () {
				const resolved = yield* Effect.exit(untilSettled(() => Promise.resolve(1), Effect.die));
				const rejected = yield* Effect.exit(
					untilSettled(
						() => Promise.reject(new Error("no")),
						(thrown) => Effect.fail(`refused: ${(thrown as Error).message}`),
					),
				);
				return [resolved, rejected];
			}),
		);
		expect(exits).toEqual([Exit.succeed(1), Exit.fail("refused: no")]);
	});

	it("aborts the signal when interrupted, and waits until the promise settled", async () => {
		const order = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const seen: string[] = [];
				const fiber = yield* Effect.forkChild(
					untilSettled(
						(signal) =>
							new Promise<void>((resolve) => {
								signal.addEventListener("abort", () => {
									seen.push("aborted");
									// Settles a turn later: the interruption must wait for it.
									queueMicrotask(() => {
										seen.push("settled");
										resolve();
									});
								});
								Latch.openUnsafe(started);
							}),
						Effect.die,
					),
					{ startImmediately: true },
				);
				yield* started.await;
				yield* Fiber.interrupt(fiber);
				seen.push("interrupted");
				return seen;
			}),
		);
		expect(order).toEqual(["aborted", "settled", "interrupted"]);
	});
});
