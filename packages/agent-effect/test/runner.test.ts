import { runTest } from "@effectified/pi-ai/testing";
import { Context, Effect, Latch, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runner } from "../src/runner.ts";

class Greeting extends Context.Service<Greeting, string>()("test/Greeting") {}

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
	reason: Schema.String,
}) {}

describe("runner", () => {
	const run = runner(Context.make(Greeting, "hello"));

	it("resolves with the Effect's value, run with the services it was given", async () => {
		expect(await run(Greeting.use(Effect.succeed), undefined)).toBe("hello");
	});

	it("rejects with the failure itself, which is how throwing code reaches Pi", async () => {
		const rejection = await run(Effect.fail(Refused.make({ reason: "no" })), undefined).catch((error) => error);
		expect(rejection).toBeInstanceOf(Refused);
	});

	it("interrupts the fiber when the signal aborts", async () => {
		const interrupted = await runTest(
			Effect.gen(function* () {
				const started = yield* Latch.make();
				const stopped = yield* Latch.make();
				const controller = new AbortController();
				const settled = run(
					Effect.andThen(Latch.open(started), Effect.never).pipe(Effect.onInterrupt(() => Latch.open(stopped))),
					controller.signal,
				).then(
					() => "resolved",
					() => "rejected",
				);
				yield* started.await;
				controller.abort();
				yield* stopped.await;
				return yield* Effect.promise(() => settled);
			}),
		);
		expect(interrupted).toBe("rejected");
	});
});
