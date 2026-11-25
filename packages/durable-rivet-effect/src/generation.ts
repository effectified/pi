// One wake of an actor as a scoped runtime: a Layer built when the actor wakes, the Effects run on it, and a close
// that leaves no work behind when the actor sleeps or is destroyed.

import { type Context, Effect, Exit, Layer, Scope } from "effect";

/** The runtime of one wake. `R` is what its Layer provides. */
export interface Generation<R> {
	/** What the Layer built. */
	readonly context: Context.Context<R>;
	/** Runs an Effect of this wake as the promise Rivet's hooks await; `close` interrupts it and waits for it. */
	readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>>;
	/** Interrupts every Effect still running, waits until each has ended, then closes the Layer's scope. */
	readonly close: Effect.Effect<void>;
}

/** Builds `layer` in a scope of its own. A Layer that fails to build leaves nothing open. */
export function open<R, E>(layer: Layer.Layer<R, E>): Effect.Effect<Generation<R>, E> {
	return Effect.gen(function* () {
		const scope = yield* Scope.make();
		const built = yield* Effect.exit(Layer.buildWithScope(layer, scope));
		if (Exit.isFailure(built)) {
			yield* Scope.close(scope, built);
			return yield* Effect.failCause(built.cause);
		}
		const runExit = Effect.runPromiseExitWith(built.value);
		const stopping = new AbortController();
		const running = new Set<Promise<unknown>>();
		return {
			context: built.value,
			run: (effect) => {
				const settled = runExit(effect, { signal: stopping.signal });
				running.add(settled);
				void settled.then(() => running.delete(settled));
				return settled;
			},
			close: Effect.gen(function* () {
				yield* Effect.promise(() => {
					stopping.abort();
					return Promise.all(running);
				});
				yield* Scope.close(scope, Exit.void);
			}),
		};
	});
}
