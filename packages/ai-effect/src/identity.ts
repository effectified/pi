// How requests identify the calling application to providers, for a part of a program: pi-ai's `withClientIdentity`
// applied to the `Models` service.

import { type ClientIdentity, withClientIdentity as piWithClientIdentity } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { Models } from "./models.ts";

/**
 * Runs `effect` with `identity` as the default identity of every request of `Models` (pi-ai's `withClientIdentity`):
 * a request's own `identity` overrides it field by field, and it overrides the identity the collection was made with.
 * The collection is the same: providers set inside are set on it.
 */
export function withClientIdentity(
	identity: ClientIdentity,
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Models> {
	return Effect.updateService(Models, (models) => piWithClientIdentity(models, identity));
}
