// One wake of an actor as a scoped runtime: a Layer built when the actor wakes, the Effects run on it, and a close
// that leaves no work behind when the actor sleeps or is destroyed.

import { Context, Effect, Exit, FiberSet, Layer, Scope } from "effect";

/** The runtime of one wake. `R` is what its Layer provides. */
export interface Generation<R> {
	/** What the Layer built. */
	readonly context: Context.Context<R>;
	/** Runs an Effect of this wake as the promise Rivet's hooks await; `close` interrupts it and waits for it. */
	readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<Exit.Exit<A, E>>;
	/**
	 * Interrupts every Effect `run` still runs and waits until each has ended, then closes the Layer, then interrupts
	 * what is left of the wake's `Work`. An Effect `run` is given afterwards is interrupted at once.
	 */
	readonly close: Effect.Effect<void>;
}

/**
 * The fibers of a wake's own work beside the Effects `run` runs, such as the operations of the actor's database. They
 * are interrupted after the Layer has closed: what the Layer does while it closes, such as Pi's last writes, runs on
 * them, and what is left then ends with the wake.
 */
export class Work extends Context.Service<Work, FiberSet.FiberSet>()(
	"@gunta/pi-durable-rivet-effect/Generation/Work",
) {}

/** Builds `layer` in a scope of its own, with the wake's `Work`. A Layer that fails to build leaves nothing open. */
export function open<R, E>(layer: Layer.Layer<R, E, Work>): Effect.Effect<Generation<R>, E> {
	return Effect.gen(function* () {
		const scope = yield* Scope.make();
		// The scope's finalizers run last first: the handlers' fibers, then the Layer, then the work's fibers.
		const opened = yield* Effect.exit(
			Effect.provideService(
				Effect.gen(function* () {
					const work = yield* FiberSet.make();
					const context = yield* Layer.buildWithScope(Layer.provide(layer, Layer.succeed(Work, work)), scope);
					const handlers = yield* FiberSet.make<unknown, unknown>();
					const runFork = yield* Effect.provideContext(FiberSet.runtime(handlers)<R>(), context);
					return { context, runFork };
				}),
				Scope.Scope,
				scope,
			),
		);
		if (Exit.isFailure(opened)) {
			yield* Scope.close(scope, opened);
			return yield* Effect.failCause(opened.cause);
		}
		const { context, runFork } = opened.value;
		return {
			context,
			run: <A, E>(effect: Effect.Effect<A, E, R>) =>
				new Promise<Exit.Exit<A, E>>((resolve) => runFork(effect).addObserver(resolve)),
			close: Scope.close(scope, Exit.void),
		};
	});
}
