// The bridge from Effect to Pi: an Effect run as the promise pi-coding-agent awaits from a handler, a tool or a
// command of an extension.

import { withoutParentSpan } from "@effectified/pi-ai";
import { Cause, type Context, Effect, Exit, Formatter, Predicate } from "effect";

/** Runs an Effect with the services it was given and settles as Pi expects of the callback it called. */
export type Run<R> = <A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) => Promise<A>;

/**
 * A `Run` whose Effects get `context`. An aborted `signal` interrupts the fiber. A failure, a defect and the
 * interruption reject with an error, which is how throwing code reaches Pi: Pi reports it as an extension error, or
 * turns it into an error result when a tool threw it.
 */
export function runner<R>(context: Context.Context<R>): Run<R> {
	// Pi keeps the runner and calls it later: its Effects' spans start their own trace.
	const runExit = Effect.runPromiseExitWith(withoutParentSpan(context));
	return (effect, signal) =>
		runExit(effect, { signal }).then((exit) =>
			Exit.isSuccess(exit) ? exit.value : Promise.reject(rejection(Cause.squash(exit.cause))),
		);
}

/** What Pi gets for a failure: Pi reads an error's message, and a tagged error's own message may be empty. */
function rejection(failure: unknown): Error {
	if (Predicate.isError(failure) && failure.message !== "") return failure;
	return new Error(Formatter.format(failure), { cause: failure });
}
