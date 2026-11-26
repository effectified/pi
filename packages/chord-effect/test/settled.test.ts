import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { SqliteError } from "../src/errors.ts";
import { settled } from "../src/settled.ts";
import { run } from "./run.ts";

describe("settled", () => {
	it("gives what the promise resolves with, and fails with SqliteError for a rejection or a throw", async () => {
		const results = await run(
			Effect.all([
				settled(() => Promise.resolve(1)),
				Effect.flip(settled(() => Promise.reject(new Error("locked")))),
				Effect.flip(
					settled((): Promise<number> => {
						throw new Error("thrown");
					}),
				),
			]),
		);
		expect(results[0]).toBe(1);
		expect(results.slice(1).map((error) => (error instanceof SqliteError ? error.message : error))).toEqual([
			"locked",
			"thrown",
		]);
	});

	it("lets an interrupted fiber finish only after the promise settled", async () => {
		const order = await run(
			Effect.gen(function* () {
				const events: string[] = [];
				const started = yield* Deferred.make<() => void>();
				const fiber = yield* Effect.forkChild(
					settled(
						() =>
							new Promise<void>((resolve) => {
								Deferred.doneUnsafe(
									started,
									Effect.succeed(() => {
										events.push("settled");
										resolve();
									}),
								);
							}),
					),
					{ startImmediately: true },
				);
				const settle = yield* Deferred.await(started);
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
				settle();
				yield* Fiber.join(interrupting);
				events.push("interrupted");
				return events;
			}),
		);
		expect(order).toEqual(["settled", "interrupted"]);
	});
});
