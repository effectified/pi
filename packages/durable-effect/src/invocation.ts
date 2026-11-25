// The invocation bridge: an Effect run as the promise Pi Durable awaits from extension code (a tool, a hook, a commit).

import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Cause, type Context, Effect, Exit } from "effect";
import { ParentContext } from "./call.ts";

/** Runs an Effect for one Pi invocation and settles as Pi expects of the extension code it called. */
export type Invoke<R> = <A, E>(effect: Effect.Effect<A, E, R>, invocation: ChordContext) => Promise<A>;

/**
 * An `Invoke` whose Effects run with `context`. Pi aborts an invocation through its Chord context: that signal
 * interrupts the fiber. A failure, a defect and the interruption reject with the error itself, which is how throwing
 * extension code reaches Pi. The invocation's context is the `ParentContext` of the fiber, so the Pi calls the Effect
 * makes keep the invocation's telemetry span and cancellation.
 */
export function invoker<R>(context: Context.Context<R>): Invoke<R> {
	const runExit = Effect.runPromiseExitWith(context);
	return (effect, invocation) =>
		runExit(Effect.provideService(effect, ParentContext, invocation), { signal: invocation.abortSignal }).then(
			(exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause))),
		);
}
