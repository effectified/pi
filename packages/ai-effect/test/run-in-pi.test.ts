// Running Effects for pi-ai as promises: values, carried failures, defects and aborts.

import { Deferred, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CarriedFailure, carriedFailure, currentRunner } from "../src/run-in-pi.ts";
import { runTest } from "../src/testing/index.ts";

class Failed extends Schema.TaggedError<Failed>()("Failed", { message: Schema.String }) {}

describe("currentRunner", () => {
	it("resolves with the value, and rejects with the failure carried", async () => {
		const failure = new Failed({ message: "no" });
		const result = await runTest(
			Effect.gen(function* () {
				const run = yield* currentRunner<never>();
				return yield* Effect.promise(async () => ({
					value: await run(Effect.succeed(1)),
					rejection: await run(Effect.fail(failure)).catch((error: unknown) => error),
				}));
			}),
		);
		expect(result.value).toBe(1);
		expect(result.rejection).toBeInstanceOf(CarriedFailure);
		expect((result.rejection as CarriedFailure).message).toBe("no");
		expect(carriedFailure(result.rejection)).toEqual(Option.some(failure));
	});

	it("rejects with a defect as it is, and interrupts the Effect when the signal aborts", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const run = yield* currentRunner<never>();
				const stopped = yield* Deferred.make<void>();
				const controller = new AbortController();
				const defect = yield* Effect.promise(() =>
					run(Effect.die(new Error("broken"))).catch((error: unknown) => error),
				);
				const pending = run(
					Effect.onInterrupt(Effect.never, () => Deferred.succeed(stopped, undefined)),
					controller.signal,
				);
				controller.abort();
				yield* Deferred.await(stopped);
				yield* Effect.promise(() => pending.catch(() => undefined));
				return defect;
			}),
		);
		expect(result).toEqual(new Error("broken"));
	});
});

describe("carriedFailure", () => {
	it("finds the failure in the chain of causes, and nothing elsewhere", () => {
		const wrapped = new Error("outer", { cause: new CarriedFailure("inner") });
		expect(carriedFailure(wrapped)).toEqual(Option.some("inner"));
		expect(carriedFailure(new Error("plain"))).toEqual(Option.none());
		expect(carriedFailure("text")).toEqual(Option.none());
	});
});
