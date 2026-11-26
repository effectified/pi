// The bridge from Effect to Chord's runtime: one Chord call under a Chord context of the calling fiber, what it
// rejects with as a tagged error.

import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { type ChordCallError, fromChord, SqliteError } from "./errors.ts";
import { traced } from "./traced.ts";

/** `attempt` with Chord's runtime rejections: its error classes as `ChordCallError`, anything else a defect. */
export function chordCall<A>(
	run: (context: Context) => Promise<A>,
	parent: Context = BACKGROUND_CONTEXT,
): Effect.Effect<A, ChordCallError> {
	return attempt(run, rejection, parent);
}

/**
 * Runs `run` with a child of `parent` under the fiber's current span (`ChordContext`'s telemetry rule), cancelled when
 * the fiber is interrupted; what it rejects with goes to `rejected`. An interrupted fiber waits until Chord settled the
 * call, so nothing of it is still running when the interruption completes; what Chord answers then is dropped.
 */
export function attempt<A, E>(
	run: (context: Context) => Promise<A>,
	rejected: (thrown: unknown) => Effect.Effect<never, E>,
	parent: Context = BACKGROUND_CONTEXT,
): Effect.Effect<A, E> {
	return Effect.flatMap(traced(parent), (under) =>
		Effect.callback<A, E>((resume, signal) => {
			// A promise executor turns a synchronous throw of `run` into a rejection too.
			const done = new Promise<A>((resolve) => resolve(run(withAbortSignal(signal, under)))).then(
				(value) => resume(Effect.succeed(value)),
				(thrown: unknown) => resume(rejected(thrown)),
			);
			return Effect.promise(() => done);
		}),
	);
}

/** `run` as an Effect for Chord's synchronous runtime calls, which throw what the async ones reject with. */
export function chordSync<A>(run: () => A): Effect.Effect<A, ChordCallError> {
	return Effect.suspend(() => {
		try {
			return Effect.succeed(run());
		} catch (thrown) {
			return rejection(thrown);
		}
	});
}

/** What a Chord runtime call threw: its `ChordCallError`, or a defect for anything Chord's runtime does not throw. */
export function rejection(thrown: unknown): Effect.Effect<never, ChordCallError> {
	const failure = fromChord(thrown);
	return failure === undefined ? Effect.die(thrown) : Effect.fail(failure);
}

/** What a store call threw: its `ChordCallError`, or the database's own error as `SqliteError`. */
export function storeRejection(thrown: unknown): Effect.Effect<never, ChordCallError | SqliteError> {
	return Effect.fail(fromChord(thrown) ?? new SqliteError({ cause: thrown }));
}
