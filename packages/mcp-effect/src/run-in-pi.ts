// Effects handed to pi-mcp as the callbacks it calls (a store, an auth provider, a request handler), run in the
// context they were given in, with their failures as the Pi errors Pi's own checks expect.

import { Cause, Context, Effect, Exit, Option, Tracer } from "effect";
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
		const run = Effect.runPromiseExitWith(withoutParentSpan(context));
		return <A>(effect: Effect.Effect<A, McpFailure, R>, signal?: AbortSignal): Promise<A> =>
			run(effect, { signal }).then(settle<A>);
	});
}

/** `currentRunner` for Pi's synchronous callbacks. */
export function currentSyncRunner<R>(): Effect.Effect<RunSyncInPi<R>, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.runSyncExitWith(withoutParentSpan(context));
		return (effect) => settle(run(effect));
	});
}

/** The value of `exit`, or what Pi should see thrown. */
function settle<A>(exit: Exit.Exit<A, McpFailure>): A {
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.findErrorOption(exit.cause);
	// Pi takes a rejected promise or a thrown error: this is the edge where an Effect's failure becomes one.
	throw Option.isSome(failure) ? toPi(failure.value) : Cause.squash(exit.cause);
}

/**
 * `context` without its current span: Pi keeps a runner and calls it later, so its Effects' spans start their own trace
 * instead of hanging under a span that ended when the runner was made.
 */
function withoutParentSpan<R>(context: Context.Context<R>): Context.Context<R> {
	// The parent span is an optional reference of the tracer: omitting it removes no service an Effect asks for.
	return Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>;
}
