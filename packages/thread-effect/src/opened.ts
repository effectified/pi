// The open harness, for what the composition builds before it: the router's constraint source and the accounts of a
// swarm's forks are services of before the harness, and read its storage once it is open.

import { Harness } from "@effectified/pi-durable";
import { Context, Deferred, Effect, Layer } from "effect";

/**
 * The harness of the composition, once `attach` has given it. The registry and the models are built before the
 * harness, and so is everything they need: what of that reads the harness storage waits here until it is open.
 */
export class Opened extends Context.Service<Opened, Deferred.Deferred<Harness.Open>>()(
	"@effectified/pi-thread/Opened",
) {}

/** The place the open harness is given to: provide it under everything that waits for the harness. */
export const layer: Layer.Layer<Opened> = Layer.effect(Opened, Deferred.make<Harness.Open>());

/** Gives the open harness: build it on top of `Harness.layer`. Until then every Effect of `on` waits. */
export const attach: Layer.Layer<never, never, Opened | Harness.Harness> = Layer.effectDiscard(
	Effect.gen(function* () {
		yield* Deferred.succeed(yield* Opened, yield* Harness.Harness);
	}),
);

/** `effect` on the harness `opened` was given, waiting for it first. */
export function on<A, E>(
	opened: Deferred.Deferred<Harness.Open>,
	effect: Effect.Effect<A, E, Harness.Harness>,
): Effect.Effect<A, E> {
	return Effect.provideServiceEffect(effect, Harness.Harness, Deferred.await(opened));
}
