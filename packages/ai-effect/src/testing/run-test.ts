// One way to run a test's Effect on both lanes: in a scope, on the test clock and the test console. It imports no test
// runner, so it runs under Vitest and under `bun test`, where `@effect/vitest` does not load.

import { Effect, Layer, type Scope } from "effect";
import { TestClock, TestConsole } from "effect/testing";

/** What `runTest` provides: a scope that closes with the test, the test clock and the test console. */
export type TestServices = Scope.Scope | TestClock.TestClock | TestConsole.TestConsole;

/**
 * Runs a test's Effect and resolves with its value, or rejects with its failure. Time stands still until the test
 * moves it: a sleep, a timeout or a deadline that reads `Clock` passes on `TestClock.adjust`, so no test waits for
 * the machine, and one that forgets to move the clock hangs until its runner's time limit. Finalizers of the scope
 * run before the promise settles.
 *
 * A part that must see real time (an engine, a file that another process writes) is wrapped in
 * `TestClock.withLive`, or the whole test uses `runLive`.
 */
export function runTest<A, E>(effect: Effect.Effect<A, E, TestServices>): Promise<A> {
	return Effect.runPromise(Effect.provide(Effect.scoped(effect), SERVICES));
}

/** `runTest` on the live clock: for a test of real processes and files. It still has the scope. */
export function runLive<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
	return Effect.runPromise(Effect.scoped(effect));
}

const SERVICES = Layer.mergeAll(TestClock.layer(), TestConsole.layer);
