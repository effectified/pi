// One wake of an actor as a scoped runtime: a Layer built when the actor wakes, the Effects run on it, and a close
// that leaves no work behind when the actor sleeps or is destroyed.

import { withoutParentSpan } from "@effectified/pi-ai";
import { Context, Effect, Exit, type Fiber, FiberSet, Layer, Scope } from "effect";

/** The runtime of one wake. `R` is what its Layer provides. */
export interface Generation<R> {
	/** What the Layer built. */
	readonly context: Context.Context<R>;
	/**
	 * Runs an Effect of this wake as a fiber of the wake's, as `FiberSet.run` does: the caller's interruption leaves it
	 * running, and `close` interrupts it and waits for it.
	 */
	readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Fiber.Fiber<A, E>>;
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
export class Work extends Context.Service<Work, FiberSet.FiberSet>()("@effectified/pi-durable-rivet/generation/Work") {}

/**
 * Builds `layer` in a scope of its own, with the wake's `Work`, outside the span of the call that opens the wake. A
 * Layer that fails to build leaves nothing open.
 */
export const open: <R, E>(layer: Layer.Layer<R, E, Work>) => Effect.Effect<Generation<R>, E> = Effect.fn(
	"Generation.open",
)(function* <R, E>(layer: Layer.Layer<R, E, Work>): Effect.fn.Return<Generation<R>, E> {
	const scope = yield* Scope.make();
	// The scope's finalizers run last first: the handlers' fibers, then the Layer, then the work's fibers.
	const opened = yield* Effect.exit(
		Effect.provideService(
			Effect.gen(function* () {
				const work = yield* FiberSet.make();
				const context = yield* Layer.buildWithScope(Layer.provide(layer, Layer.succeed(Work, work)), scope);
				const handlers = yield* FiberSet.make<unknown, unknown>();
				return { context, handlers };
			}),
			Scope.Scope,
			scope,
		).pipe(
			// The wake outlives the call that opens it, and its Layers keep contexts for later work (a driver's calls, a
			// task Pi runs later): built under the call's span, that work would hang under a span that ended. So the
			// Layers' own spans start traces of their own, and what they keep runs under whoever runs it later.
			Effect.updateContext((context: Context.Context<never>) => withoutParentSpan(context)),
		),
	);
	if (Exit.isFailure(opened)) {
		yield* Scope.close(scope, opened);
		return yield* Effect.failCause(opened.cause);
	}
	const { context, handlers } = opened.value;
	return {
		context,
		run: (effect) => FiberSet.run(handlers, Effect.provideContext(effect, context)),
		close: Scope.close(scope, Exit.void),
	};
});
