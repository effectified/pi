// Effects that pi-ai calls back as promises (a credential store, an auth context, a login prompt), run in the context
// of the Effect that handed them over, with their failure carried through pi-ai's promise code unchanged.

import { formatThrownValue } from "@earendil-works/pi-ai";
import { Cause, Context, Effect, Exit, Option, Predicate, Schema, Tracer } from "effect";

/**
 * `context` without its current span, for Effects a callback Pi keeps runs later: their spans start a trace of their
 * own instead of hanging under a span that ended when the callback was made (a tracer drops or misplaces those).
 */
export function withoutParentSpan<R>(context: Context.Context<R>): Context.Context<R> {
	// The parent span is an optional reference of the tracer: omitting it removes no service an Effect asks for.
	return Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>;
}

/** Runs an Effect for pi-ai as a promise. Aborting `signal` interrupts it. */
export type RunInPi<R> = <A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) => Promise<A>;

/**
 * The failure of an Effect that pi-ai ran, as the rejection pi-ai sees. Its message is the failure's, so a pi-ai error
 * that wraps it (`ModelsError` with a cause) still says what went wrong.
 */
export class CarriedFailure extends Schema.TaggedError<CarriedFailure, { readonly brand: unique symbol }>()(
	"CarriedFailure",
	{ failure: Schema.Defect() },
) {
	override get message(): string {
		return formatThrownValue(this.failure);
	}
}

/**
 * A runner for Effects that pi-ai calls back, in the context of the Effect that calls this. The promise resolves with
 * the value, or rejects with a `CarriedFailure` of the failure, or with the defect or interruption, squashed.
 */
// Untraced: the runner's work happens later, in pi-ai's callbacks, each under a span of its own.
export const currentRunner = Effect.fnUntraced(function* <R>(): Effect.fn.Return<RunInPi<R>, never, R> {
	const context = yield* Effect.map(Effect.context<R>(), withoutParentSpan);
	const run = Effect.runPromiseExitWith(context);
	return (effect, signal) => run(effect, { signal }).then(settle);
});

/** The failure an Effect run by `currentRunner` carried, found in `error` or in the chain of its causes. */
export function carriedFailure(error: unknown): Option.Option<unknown> {
	// Wire input: what pi-ai rejected with, our `CarriedFailure` or an error of pi-ai's that wraps one as its cause.
	for (let current = error; Predicate.isError(current); current = current.cause) {
		if (isCarriedFailure(current)) return Option.some(current.failure);
	}
	return Option.none();
}

const isCarriedFailure = Schema.is(CarriedFailure);

/** The value of an Exit, or the rejection that carries its failure to pi-ai. */
function settle<A, E>(exit: Exit.Exit<A, E>): A | Promise<never> {
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.findErrorOption(exit.cause);
	return Promise.reject(
		Option.isSome(failure) ? CarriedFailure.make({ failure: failure.value }) : Cause.squash(exit.cause),
	);
}
