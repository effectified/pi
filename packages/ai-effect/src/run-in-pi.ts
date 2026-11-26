// Effects that pi-ai calls back as promises (a credential store, an auth context, a login prompt), run in the context
// of the Effect that handed them over, with their failure carried through pi-ai's promise code unchanged.

import { Cause, Effect, Exit, Option } from "effect";

/** Runs an Effect for pi-ai as a promise. Aborting `signal` interrupts it. */
export type RunInPi<R> = <A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal) => Promise<A>;

/**
 * The failure of an Effect that pi-ai ran, as the rejection pi-ai sees. Its message is the failure's, so a pi-ai error
 * that wraps it (`ModelsError` with a cause) still says what went wrong.
 */
export class CarriedFailure extends Error {
	readonly failure: unknown;

	constructor(failure: unknown) {
		super(failure instanceof Error ? failure.message : String(failure));
		this.name = "CarriedFailure";
		this.failure = failure;
	}
}

/**
 * A runner for Effects that pi-ai calls back, in the context of the Effect that calls this. The promise resolves with
 * the value, or rejects with a `CarriedFailure` of the failure, or with the defect or interruption, squashed.
 */
export function currentRunner<R>(): Effect.Effect<RunInPi<R>, never, R> {
	return Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.runPromiseExitWith(context);
		return async (effect, signal) => settle(await run(effect, { signal }));
	});
}

/** The failure an Effect run by `currentRunner` carried, found in `error` or in the chain of its causes. */
export function carriedFailure(error: unknown): Option.Option<unknown> {
	for (let current = error; current instanceof Error; current = current.cause) {
		if (current instanceof CarriedFailure) return Option.some(current.failure);
	}
	return Option.none();
}

function settle<A, E>(exit: Exit.Exit<A, E>): A {
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.findErrorOption(exit.cause);
	throw Option.isSome(failure) ? new CarriedFailure(failure.value) : Cause.squash(exit.cause);
}
