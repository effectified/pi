// pi-ai's session resources (what a provider keeps per conversation, such as an open WebSocket) in Effect terms: a
// cleanup registered for a scope, and the cleanup of a session as an Effect with a typed failure.

import {
	formatThrownValue,
	cleanupSessionResources as piCleanupSessionResources,
	registerSessionResourceCleanup as piRegisterSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { Array as Arr, Effect, type Scope } from "effect";
import { SessionCleanupError } from "./errors.ts";

/** The id of a session whose resources pi-ai cleans up; absent for every session. pi-ai's `sessionId`. */
type SessionId = Parameters<typeof piCleanupSessionResources>[0];

/**
 * Registers `cleanup` with pi-ai until the scope closes. pi-ai runs it for a session when that session's resources
 * are cleaned up, and for every session when `sessionId` is absent. pi-ai calls it without waiting, so it must not
 * wait either; one that waits, or fails, is reported by `cleanupSessionResources`.
 */
export const registerSessionResourceCleanup = Effect.fn("SessionResources.registerSessionResourceCleanup")(function* <
	R = never,
>(cleanup: (sessionId: SessionId) => Effect.Effect<void, never, R>): Effect.fn.Return<void, never, Scope.Scope | R> {
	const context = yield* Effect.context<R>();
	// pi-ai's cleanup is synchronous: a cleanup that waits or dies throws here, which pi-ai collects and reports.
	const runSync = Effect.runSyncWith(context);
	yield* Effect.acquireRelease(
		Effect.sync(() => piRegisterSessionResourceCleanup((sessionId) => runSync(cleanup(sessionId)))),
		(unregister) => Effect.sync(unregister),
	);
});

/**
 * Runs every registered cleanup for `sessionId`, or for all sessions when absent (pi-ai's `cleanupSessionResources`).
 * Each runs even when another fails; then fails with `SessionCleanupError` listing what failed.
 */
export const cleanupSessionResources = Effect.fn("SessionResources.cleanupSessionResources")(function* (
	sessionId?: SessionId,
): Effect.fn.Return<void, SessionCleanupError> {
	return yield* Effect.try({
		try: () => piCleanupSessionResources(sessionId),
		catch: (error) =>
			SessionCleanupError.make({
				// Wire input: what pi-ai threw, an `AggregateError` of the cleanups' throws.
				messages:
					error instanceof AggregateError ? Arr.map(error.errors, formatThrownValue) : [formatThrownValue(error)],
			}),
	});
});
