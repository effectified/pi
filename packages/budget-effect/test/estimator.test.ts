import { ModelId, ProviderId } from "@effectified/pi-ai";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { type BudgetRequest, Estimator } from "../src/index.ts";

const CHAT: BudgetRequest = { kind: "chat", provider: ProviderId.make("acme"), model: ModelId.make("large") };

describe("Estimator", () => {
	it("fixed gives the same amount for every request", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const estimator = yield* Estimator;
				expect(yield* estimator.estimate(CHAT)).toBe(50_000n);
				expect(yield* estimator.estimate({ ...CHAT, kind: "images", model: ModelId.make("painter") })).toBe(
					50_000n,
				);
			}).pipe(Effect.provide(Estimator.fixed(50_000n))),
		));

	it("is a port: a product's rule is a function of the request", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const estimator = yield* Estimator;
				expect(yield* estimator.estimate(CHAT)).toBe(90_000n);
				expect(yield* estimator.estimate({ ...CHAT, model: ModelId.make("small") })).toBe(1_000n);
			}).pipe(
				Effect.provide(
					Layer.succeed(Estimator, {
						estimate: (request) => Effect.succeed(request.model === "large" ? 90_000n : 1_000n),
					}),
				),
			),
		));
});
