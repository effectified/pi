// pi-ai's session resources in Effect terms: a cleanup registered for a scope, and the cleanup as an Effect.

import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { cleanupSessionResources, registerSessionResourceCleanup, SessionCleanupError } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

describe("registerSessionResourceCleanup", () => {
	it("runs the cleanup for each session cleaned up while its scope is open, and not after", async () => {
		const calls = await runTest(
			Effect.gen(function* () {
				const calls: Array<string | undefined> = [];
				const scope = yield* Scope.make();
				yield* registerSessionResourceCleanup((sessionId) => Effect.sync(() => void calls.push(sessionId))).pipe(
					Scope.provide(scope),
				);
				yield* cleanupSessionResources("one");
				yield* cleanupSessionResources();
				yield* Scope.close(scope, Exit.void);
				yield* cleanupSessionResources("after");
				return calls;
			}),
		);
		expect(calls).toEqual(["one", undefined]);
	});
});

describe("cleanupSessionResources", () => {
	it("runs every cleanup, then fails with SessionCleanupError naming the ones that failed", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const ran: string[] = [];
				yield* registerSessionResourceCleanup(() => Effect.die(new Error("socket stuck")));
				yield* registerSessionResourceCleanup(() => Effect.sync(() => void ran.push("second")));
				const failure = yield* Effect.flip(cleanupSessionResources("s"));
				return { failure, ran };
			}),
		);
		expect(result.ran).toEqual(["second"]);
		expect(result.failure).toBeInstanceOf(SessionCleanupError);
		expect(result.failure.messages).toHaveLength(1);
		expect(result.failure.messages[0]).toContain("socket stuck");
	});
});
