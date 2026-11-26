// The call bridge: one call into Pi run as an Effect, cancelled through Pi's AbortSignal when the fiber is interrupted.

import { BACKGROUND_CONTEXT, type Context as ChordContext, withAbortSignal } from "@earendil-works/chord/context";
import type { Result } from "@earendil-works/pi-durable/env";
import { Effect } from "effect";

/**
 * Runs an environment operation under a Chord context that is cancelled when the calling fiber is interrupted, and
 * fails with `onError` of Pi's error result. An interrupted fiber waits until Pi settled the call, so nothing of it
 * still runs when the interruption completes. Pi's environments return their failures; a rejection is a defect.
 */
export function result<A, PiError, E>(
	run: (context: ChordContext) => Promise<Result<A, PiError>>,
	onError: (error: PiError) => E,
): Effect.Effect<A, E> {
	return Effect.flatMap(
		abortable((signal) => run(withAbortSignal(signal, BACKGROUND_CONTEXT)), Effect.die),
		(settled) => (settled.ok ? Effect.succeed(settled.value) : Effect.fail(onError(settled.error))),
	);
}

/**
 * Runs a Pi call that takes an AbortSignal with the fiber's: interrupting the fiber aborts the call and waits until
 * Pi settled it. A rejection becomes `onRejection` of it.
 */
export function abortable<A, E>(
	run: (signal: AbortSignal) => Promise<A>,
	onRejection: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		// A promise executor turns a synchronous throw of `run` into a rejection too.
		const done = new Promise<A>((resolve) => resolve(run(signal))).then(
			(value) => resume(Effect.succeed(value)),
			(cause: unknown) => resume(onRejection(cause)),
		);
		return Effect.promise(() => done);
	});
}

/**
 * Runs a Pi call that cannot be cancelled (no AbortSignal): interrupting the fiber stops waiting for it at once, and
 * Pi's call goes on to its own end (an `ssh` run ends within its timeout). A rejection becomes `onRejection` of it.
 */
export function unabortable<A, E>(run: () => Promise<A>, onRejection: (cause: unknown) => E): Effect.Effect<A, E> {
	return Effect.tryPromise({ try: () => run(), catch: onRejection });
}
