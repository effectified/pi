// The bridge from Effect to Pi: an Effect run as the promise pi-agent-core awaits from a hook or a tool.

import { Cause, type Context, Effect, Exit } from "effect";

/** Runs an Effect with the services it was given and settles as Pi expects of the callback it called. */
export type Run<R> = <A, E>(effect: Effect.Effect<A, E, R>, signal: AbortSignal | undefined) => Promise<A>;

/**
 * A `Run` whose Effects get `context`. An aborted `signal` interrupts the fiber. A failure, a defect and the
 * interruption reject with the error itself, which is how throwing code reaches Pi.
 */
export function runner<R>(context: Context.Context<R>): Run<R> {
	const runExit = Effect.runPromiseExitWith(context);
	return (effect, signal) =>
		runExit(effect, { signal }).then((exit) =>
			Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)),
		);
}
