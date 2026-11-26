// A SQLite promise of Chord as an Effect that waits for it to settle, for the calls Chord gives no signal.

import { Effect } from "effect";
import { SqliteError } from "./errors.ts";

/**
 * `run`'s promise as an Effect that fails with `SqliteError`. Chord's SQLite calls take no signal, so an interrupted
 * fiber waits until the promise settled: nothing of the work is still running when the interruption completes, and
 * what it settled with is dropped.
 */
export function settled<A>(run: () => Promise<A>): Effect.Effect<A, SqliteError> {
	return Effect.callback<A, SqliteError>((resume) => {
		// A promise executor turns a synchronous throw of `run` into a rejection too.
		const done = new Promise<A>((resolve) => resolve(run())).then(
			(value) => resume(Effect.succeed(value)),
			(cause: unknown) => resume(Effect.fail(new SqliteError({ cause }))),
		);
		return Effect.promise(() => done);
	});
}
