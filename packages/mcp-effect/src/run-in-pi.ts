// Effects handed to pi-mcp as the callbacks it calls (a store, an auth provider, a request handler), run in the
// context they were given in, with their failures as the Pi errors Pi's own checks expect.

import { Cause, Effect, Exit, Option } from "effect";
import { type McpFailure, toPi } from "./errors.ts";

/** Runs an Effect for Pi as a promise: what it needs comes from the context, and aborting `signal` interrupts it. */
export type RunInPi<R> = <A>(effect: Effect.Effect<A, McpFailure, R>, signal?: AbortSignal) => Promise<A>;

/** Runs an Effect for Pi at once, where Pi calls back synchronously. An Effect that would wait is a defect. */
export type RunSyncInPi<R> = <A>(effect: Effect.Effect<A, McpFailure, R>) => A;

/**
 * A runner for Effects that Pi calls back, in the context of the Effect that calls this: the promise resolves with
 * the value, or rejects with the Pi error of the failure (`toPi`), or with the defect or interruption, squashed.
 */
export function currentRunner<R>(): Effect.Effect<RunInPi<R>, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.runPromiseExitWith(context);
		return async (effect, signal) => settle(await run(effect, { signal }));
	});
}

/** `currentRunner` for Pi's synchronous callbacks. */
export function currentSyncRunner<R>(): Effect.Effect<RunSyncInPi<R>, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.runSyncExitWith(context);
		return (effect) => settle(run(effect));
	});
}

/** The value of `exit`, or what Pi should see thrown. */
function settle<A>(exit: Exit.Exit<A, McpFailure>): A {
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.findErrorOption(exit.cause);
	throw Option.isSome(failure) ? toPi(failure.value) : Cause.squash(exit.cause);
}
