// A refusal with a retry hint: Rivet did not do what it was asked and says when to ask again. How the hint is read,
// and the one rule by which this host asks again, a bounded number of times.

import { Effect, Option, Schedule, Schema } from "effect";

/**
 * How often a refused request is sent again before its refusal goes to the caller. Rivet's storage refuses while a
 * volume changes hands (`depot.overloaded` with the reason `volume_transition`, during a fork or a sleep) and hints
 * at 100 milliseconds, so five more attempts cover a transition many times over.
 */
export const RETRIES = 5;

/** The longest wait for one hint: a larger hint is asked again this soon, and refused again if it is too early. */
export const MAX_WAIT_MILLIS = 5_000;

/**
 * The hint of a refusal in milliseconds: `retry_after_ms` in the metadata of Rivet's error, as rivetkit reads it.
 * None for anything else. An error with the hint was refused before it ran, so nothing of it was applied: that is
 * what Rivet's messages for these errors say ("refused the command", "refused the request before running it").
 */
export function retryAfterMillis(error: unknown): Option.Option<number> {
	// A trust boundary: the error is whatever rivetkit threw, and its metadata whatever the engine sent.
	return Option.map(decodeHinted(error), (hinted) => hinted.metadata.retry_after_ms);
}

/** What a refusal with a hint carries: rivetkit's error, or anything, with the engine's metadata. */
const Hinted = Schema.Struct({
	metadata: Schema.Struct({ retry_after_ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)) }),
});

const decodeHinted = Schema.decodeUnknownOption(Hinted);

/** How long to wait before asking again after a refusal with this hint. */
export function waitMillis(hint: number): number {
	return Math.min(hint, MAX_WAIT_MILLIS);
}

/**
 * The schedule of `Effect.retry` for a request Rivet may refuse with a hint: while the failure has a hint (`hintOf`
 * reads it, and says none for every other failure), the request is sent again after the hinted time, at most
 * `RETRIES` more times; then the last refusal goes to the caller. The wait is a sleep on `Clock`, so it is
 * interrupted with the fiber that waits.
 */
export function honouringHint<E>(hintOf: (error: E) => Option.Option<number>): Schedule.Schedule<number, E> {
	return Schedule.recurs(RETRIES).pipe(
		Schedule.while(({ input }: Schedule.Metadata<number, E>) => Option.isSome(hintOf(input))),
		// The hint is there: the schedule ended above for a failure without one.
		Schedule.modifyDelay(({ input }) => Effect.succeed(waitMillis(Option.getOrElse(hintOf(input), () => 0)))),
	);
}
