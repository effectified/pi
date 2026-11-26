// The call bridge: one Pi Durable call run as an Effect, under the Chord context of the fiber that makes it.

import { BACKGROUND_CONTEXT, type Context as ChordContext, withAbortSignal } from "@earendil-works/chord/context";
import { Context, Effect } from "effect";
import { Cancelled, type DurableError, fromRejection, type UnexpectedError } from "./errors.ts";

/**
 * The Chord context the Pi calls of a fiber are made under: its telemetry span, its values and its cancellation
 * (a deadline, a signal) reach every call. Default: Chord's background context. A host sets it for a region with
 * `Effect.provideService(effect, ParentContext, context)`; inside a tool or hook handler it is the context of that
 * Pi invocation. A cancelled parent fails the calls with `Cancelled`.
 */
export const ParentContext: Context.Reference<ChordContext> = Context.Reference<ChordContext>(
	"@effectified/pi-durable/ParentContext",
	{ defaultValue: () => BACKGROUND_CONTEXT },
);

/**
 * Runs `run` with a Chord context that is cancelled when the calling fiber is interrupted. A rejection fails the
 * Effect with its `DurableError`. An interrupted fiber waits until Pi settled the call, so nothing of the call is
 * still running when the interruption completes; what Pi answers then (a result, or its cancellation) is dropped.
 * `parent` is the context of the Pi invocation the call is made from (a hook's), whose telemetry span and
 * cancellation the call keeps; without it, it is the `ParentContext` of the fiber.
 */
export function call<A>(
	run: (context: ChordContext) => Promise<A>,
	parent?: ChordContext,
): Effect.Effect<A, DurableError> {
	const under = (context: ChordContext) =>
		Effect.mapError(
			settled((signal) => run(withAbortSignal(signal, context))),
			// Chord rejects a cancelled call with its signal's reason, whatever that is: a deadline's `TimeoutError` too.
			(error) => (isReasonOf(context.abortSignal, error) ? new Cancelled({ cause: error.cause }) : error),
		);
	return parent === undefined ? Effect.flatMap(Effect.service(ParentContext), under) : under(parent);
}

/** Whether `error` is what Pi rejected with because `signal`, the parent's, was aborted. */
function isReasonOf(signal: AbortSignal | undefined, error: DurableError): error is UnexpectedError {
	return signal?.aborted === true && error._tag === "UnexpectedError" && error.cause === signal.reason;
}

/**
 * One call on Pi's transaction inside a commit callback, where Pi takes no context: the commit is the scope. An
 * interrupted fiber waits until Pi settled it, as for `call`.
 */
export function step<A>(run: () => Promise<A>): Effect.Effect<A, DurableError> {
	return settled(run);
}

function settled<A>(run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, DurableError> {
	return Effect.callback<A, DurableError>((resume, signal) => {
		// A promise executor turns a synchronous throw of `run` into a rejection too.
		const done = new Promise<A>((resolve) => resolve(run(signal))).then(
			(value) => resume(Effect.succeed(value)),
			(cause: unknown) => resume(Effect.fail(fromRejection(cause))),
		);
		return Effect.promise(() => done);
	});
}
