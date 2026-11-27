// How Rivet names an actor, as this host hands it on: the id the engine gave it, branded so that it never passes for
// another id, and the key it was created under.

import { Schema } from "effect";

/**
 * The id the engine gave an actor (`c.actorId` inside it, what `getOrCreate`, `get` and `fork` resolve to outside).
 * Rivet's ids are plain strings; the brand is applied where one enters this package: Rivet's actor context, a
 * resolved handle, a decoded reply. A handle a product builds itself takes `ActorId.make(id)`.
 */
export const ActorId = Schema.String.pipe(Schema.brand("ActorId"));

/** The id the engine gave an actor. */
export type ActorId = typeof ActorId.Type;

/**
 * An actor's key as Rivet keeps it: the strings it was created under. Not branded: callers make keys of their own and
 * of other keys (`[...me.key, "what-if"]`), and `Client`'s functions take any key.
 */
export const ActorKey = Schema.Array(Schema.String);

/** An actor's key as Rivet keeps it. */
export type ActorKey = typeof ActorKey.Type;
