// The call bridge: one call into Pi run as an Effect, cancelled through Pi's AbortSignal when the fiber is interrupted.

import { ChordContext, type Context, withAbortSignal } from "@effectified/pi-chord/context";
import { fromResult, type Result } from "@effectified/pi-durable/env";
import { Effect } from "effect";

/**
 * Runs an environment operation under the Chord context of the calling fiber (`ChordContext.scoped`: its current
 * span, when the program provides `PiTelemetry`), cancelled when the fiber is interrupted, and fails with `onError`
 * of Pi's error result. An interrupted fiber waits until Pi settled the call, so nothing of it still runs when the
 * interruption completes. Pi's environments return their failures; a rejection is a defect.
 */
export function result<A, PiError, E>(
	run: (context: Context) => Promise<Result<A, PiError>>,
	onError: (error: PiError) => E,
): Effect.Effect<A, E> {
	return Effect.scoped(
		Effect.flatMap(ChordContext.scoped(), (context) =>
			Effect.flatMap(
				// The fiber's signal, not only the scope's: the scope closes after the wait for Pi to settle, so its
				// signal alone would never abort the call that wait is for.
				abortable((signal) => run(withAbortSignal(signal, context)), Effect.die),
				(settled) => Effect.mapError(fromResult(settled), onError),
			),
		),
	);
}

/**
 * Runs a Pi call that takes an AbortSignal with the fiber's: interrupting the fiber aborts the call and waits until
 * Pi settled it. A rejection, or a synchronous throw of `run`, becomes `onRejection` of it.
 */
export function abortable<A, E>(
	run: (signal: AbortSignal) => Promise<A>,
	onRejection: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		const done = settle(() => run(signal), onRejection, resume);
		return Effect.promise(() => done);
	});
}

/**
 * Runs a Pi call that cannot be cancelled (no AbortSignal): interrupting the fiber stops waiting for it at once, and
 * Pi's call goes on to its own end (an `ssh` run ends within its timeout). A rejection, or a synchronous throw of
 * `run`, becomes `onRejection` of it.
 */
export function unabortable<A, E>(
	run: () => Promise<A>,
	onRejection: (cause: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume) => {
		settle(run, onRejection, resume);
	});
}

/** Resumes with what `run` settles with; the promise it returns settles after that. */
function settle<A, E>(
	run: () => Promise<A>,
	onRejection: (cause: unknown) => Effect.Effect<never, E>,
	resume: (effect: Effect.Effect<A, E>) => void,
): Promise<void> {
	try {
		return run().then(
			(value) => resume(Effect.succeed(value)),
			(cause: unknown) => resume(onRejection(cause)),
		);
	} catch (thrown) {
		resume(onRejection(thrown));
		return Promise.resolve();
	}
}
