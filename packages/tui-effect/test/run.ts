// How this package's tests run an Effect on both lanes: in a scope, on the test clock. It imports no test runner, so
// it runs under Vitest and under `bun test`; this package does not depend on `@effectified/pi-ai/testing`'s `runTest`.

import { Effect, type Scope } from "effect";
import { TestClock } from "effect/testing";

/** Runs `effect` in a scope that closes before the promise settles; time stands still until the test moves it. */
export function run<A, E>(effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock>): Promise<A> {
	return Effect.runPromise(Effect.provide(Effect.scoped(effect), TestClock.layer()));
}
