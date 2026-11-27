// A promise of Chord as an Effect that waits for it to settle: an interrupted fiber completes only after Chord's work.

import { Effect } from "effect";
import { SqliteError } from "./errors.ts";

/**
 * The promise `start` makes, as an Effect: its value, or what `rejected` makes of its rejection or of a synchronous
 * throw of `start`. Interrupting the fiber aborts `signal`, then waits until the promise settled, so nothing of the
 * work is still running when the interruption completes; what it settled with then is dropped.
 */
export function untilSettled<A, E>(
	start: (signal: AbortSignal) => Promise<A>,
	rejected: (thrown: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		let promise: Promise<A>;
		try {
			promise = start(signal);
		} catch (thrown) {
			resume(rejected(thrown));
			return;
		}
		const done = promise.then(
			(value) => resume(Effect.succeed(value)),
			(thrown: unknown) => resume(rejected(thrown)),
		);
		return Effect.promise(() => done);
	});
}

/**
 * `run`'s promise as an Effect that fails with `SqliteError`. Chord's SQLite calls take no signal, so an interrupted
 * fiber waits until the promise settled, as `untilSettled` does.
 */
export function settled<A>(run: () => Promise<A>): Effect.Effect<A, SqliteError> {
	return untilSettled(run, (cause) => Effect.fail(SqliteError.make({ cause })));
}
