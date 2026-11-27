// A promise of pi-agent-core as an Effect that waits for it to settle: an interrupted fiber completes only after Pi's
// work, so no hook or tool of it outlives the Effect.

import { Effect } from "effect";

/**
 * The promise `start` makes, given an abort signal the fiber owns, as an Effect: its value, or what `rejected` makes of
 * its rejection. Interrupting the fiber aborts `signal`, then waits until the promise settled; what it settled with
 * then is dropped.
 */
export function untilSettled<A, E>(
	start: (signal: AbortSignal) => Promise<A>,
	rejected: (thrown: unknown) => Effect.Effect<never, E>,
): Effect.Effect<A, E> {
	return Effect.callback<A, E>((resume, signal) => {
		const done = start(signal).then(
			(value) => resume(Effect.succeed(value)),
			(thrown: unknown) => resume(rejected(thrown)),
		);
		return Effect.promise(() => done);
	});
}
