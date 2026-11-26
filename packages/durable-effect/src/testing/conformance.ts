// Pi Durable's conformance suites for a storage and for an execution environment, each case an Effect a test runs.

import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	createEnvConformance,
	createExpectAssertions,
	createStorageConformance,
	type EnvConformanceOptions,
	type ExpectLike,
} from "@earendil-works/pi-durable/testing";
import { Effect, type Layer, type Scope } from "effect";
import { HarnessStorage } from "../storage.ts";

/** One case of a conformance suite: a test of its name runs `run`, within `timeoutMs` when it says. */
export interface Case {
	readonly name: string;
	/** Cases that wait for an environment's watch latency need longer than a test runner's default. */
	readonly timeoutMs?: number;
	/** The case, on a fresh storage or environment. A failed assertion is a defect, with the runner's own error. */
	readonly run: Effect.Effect<void>;
}

/**
 * Pi's storage conformance suite (Pi's `createStorageConformance`) for the storage of `storage`: each case builds the
 * Layer anew and runs on its storage. `expect` is the test runner's (Vitest's, Jest's), which the cases assert with.
 * Register them with the runner: `for (const c of cases) it(c.name, () => Effect.runPromise(c.run))`.
 */
export function storageConformance<E>(
	storage: Layer.Layer<HarnessStorage, E>,
	expect: ExpectLike,
): Effect.Effect<ReadonlyArray<Case>> {
	return Effect.sync(() =>
		createStorageConformance({
			assertions: createExpectAssertions(expect),
			withStorage: (use) =>
				Effect.runPromise(
					Effect.provide(
						HarnessStorage.use((opened) => Effect.promise(() => use(opened))),
						storage,
					),
				),
		}).map((testCase) => ({ name: testCase.name, run: Effect.promise(() => testCase.run()) })),
	);
}

/** What Pi's environment suite takes besides the environment and the assertions. */
export type EnvOptions = Pick<EnvConformanceOptions, "shell" | "symlinks" | "listFiles">;

/**
 * Pi's execution environment conformance suite (Pi's `createEnvConformance`) for the environment `env` gives: each
 * case runs it in a scope of its own, and it must give an environment whose `cwd` is a fresh, empty, writable
 * directory. `expect` as for `storageConformance`.
 */
export function envConformance<E>(
	env: Effect.Effect<ExecutionEnv, E, Scope.Scope>,
	expect: ExpectLike,
	options?: EnvOptions,
): Effect.Effect<ReadonlyArray<Case>> {
	return Effect.sync(() =>
		createEnvConformance({
			...options,
			assertions: createExpectAssertions(expect),
			withEnv: (use) =>
				Effect.runPromise(Effect.scoped(Effect.flatMap(env, (opened) => Effect.promise(() => use(opened))))),
		}).map((testCase) => ({
			name: testCase.name,
			...(testCase.timeoutMs === undefined ? {} : { timeoutMs: testCase.timeoutMs }),
			run: Effect.promise(() => testCase.run()),
		})),
	);
}
