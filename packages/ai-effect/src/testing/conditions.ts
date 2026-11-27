// Waiting until a condition on a test fake's state holds: the fake says when its state changed, a test waits.

import { Effect, Latch } from "effect";

/** Conditions on the state of one test fake. */
export interface Conditions {
	/**
	 * Succeeds once `holds` is true: asked now, and again at every `changed`. It never reads the clock, so it waits for
	 * the fake, not for time; a condition that never holds waits until the test's own time limit.
	 */
	readonly when: (holds: () => boolean) => Effect.Effect<void>;
	/** Asks every waiting condition again. The fake calls it after each change of the state the conditions read. */
	readonly changed: () => void;
}

/** New conditions, with none waiting. */
export function conditions(): Conditions {
	// A set, not a `Ref`: a fake calls `changed` synchronously, outside any Effect.
	const waiting = new Set<{ readonly holds: () => boolean; readonly latch: Latch.Latch }>();
	return {
		when: Effect.fn("Conditions.when")(function* (holds: () => boolean) {
			if (holds()) return;
			// Made and registered in the same step as the check, so a `changed` in between cannot be missed.
			const wait = { holds, latch: Latch.makeUnsafe() };
			waiting.add(wait);
			// Gone once it was met or given up, so a fake asked many times keeps only the waits that still wait.
			yield* Effect.ensuring(
				wait.latch.await,
				Effect.sync(() => waiting.delete(wait)),
			);
		}),
		changed: () => {
			for (const wait of waiting) if (wait.holds()) wait.latch.openUnsafe();
		},
	};
}
