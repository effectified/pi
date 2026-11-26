// pi-ai's session resources (what a provider keeps per conversation, such as an open WebSocket) in Effect terms: a
// cleanup registered for a scope, and the cleanup of a session as an Effect with a typed failure.

import {
	cleanupSessionResources as piCleanupSessionResources,
	registerSessionResourceCleanup as piRegisterSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { Effect, Exit, type Scope } from "effect";
import { SessionCleanupError } from "./errors.ts";

/**
 * Registers `cleanup` with pi-ai until the scope closes. pi-ai runs it for a session when that session's resources
 * are cleaned up, and for every session when `sessionId` is absent. pi-ai calls it without waiting, so it must not
 * wait either; one that waits, or fails, is reported by `cleanupSessionResources`.
 */
export function registerSessionResourceCleanup<R = never>(
	cleanup: (sessionId: string | undefined) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, Scope.Scope | R> {
	return Effect.gen(function* () {
		const runSync = Effect.runSyncExitWith(yield* Effect.context<R>());
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				piRegisterSessionResourceCleanup((sessionId) => {
					const exit = runSync(cleanup(sessionId));
					if (Exit.isFailure(exit)) throw new Error(`Session cleanup did not complete: ${String(exit.cause)}`);
				}),
			),
			(unregister) => Effect.sync(unregister),
		);
	});
}

/**
 * Runs every registered cleanup for `sessionId`, or for all sessions when absent (pi-ai's `cleanupSessionResources`).
 * Each runs even when another fails; then fails with `SessionCleanupError` listing what failed.
 */
export function cleanupSessionResources(sessionId?: string): Effect.Effect<void, SessionCleanupError> {
	return Effect.try({
		try: () => piCleanupSessionResources(sessionId),
		catch: (error) =>
			new SessionCleanupError({
				messages:
					error instanceof AggregateError
						? error.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause)))
						: [error instanceof Error ? error.message : String(error)],
			}),
	});
}
