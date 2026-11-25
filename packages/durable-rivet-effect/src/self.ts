// Working with actors from inside an actor: the definition the actor runs as, as far as a caller needs it, a handle
// of the actor itself and of its siblings, and Rivet's client of the engine the actor runs on.

import { Effect, Layer, type Option } from "effect";
import type * as Action from "./action.ts";
import { ActorEngine, ActorInfo } from "./actor-context.ts";
import * as Client from "./client.ts";
import type { EngineUnavailable } from "./errors.ts";

/** The actions actor code wants to call on an actor of its own definition: any part of the actor's actions. */
export type Actions = Readonly<Record<string, Action.Any>>;

/**
 * The definition of the actor this Effect runs in, as `Client` takes one: the name the actor is registered under,
 * and `actions`. Inside an actor its own `Actor.Definition` is not a value, since the definition is made of the code
 * that runs here; the actions a plugin or a product defines beside it are.
 */
export function definition<const A extends Actions>(
	actions: A,
): Effect.Effect<Client.Target<string, A>, never, ActorInfo> {
	return ActorInfo.use((info) => Effect.succeed({ name: info.name, actions }));
}

/** A handle of the actor this Effect runs in, for `Client.fork`, `Client.status` and the rest. */
export function handle<const A extends Actions>(
	actions: A,
): Effect.Effect<Client.Handle<Client.Target<string, A>>, never, ActorInfo> {
	return ActorInfo.use((info) =>
		Effect.succeed({ definition: { name: info.name, actions }, actorId: info.actorId, key: info.key }),
	);
}

/** The actor of this actor's definition under `key`, if there is one: `Client.find`. It never creates one. */
export function find<const A extends Actions>(
	actions: A,
	key: Client.Key,
): Effect.Effect<
	Option.Option<Client.Handle<Client.Target<string, A>>>,
	EngineUnavailable,
	ActorInfo | Client.RivetClient
> {
	return Effect.flatMap(definition(actions), (own) => Client.find(own, key));
}

/** The actor of this actor's definition under `key`, created empty when there is none: `Client.getOrCreate`. */
export function getOrCreate<const A extends Actions>(
	actions: A,
	key: Client.Key,
): Effect.Effect<Client.Handle<Client.Target<string, A>>, EngineUnavailable, ActorInfo | Client.RivetClient> {
	return Effect.flatMap(definition(actions), (own) => Client.getOrCreate(own, key));
}

/**
 * The `RivetClient` of an actor: Rivet's own client of the engine the actor runs on, made by rivetkit from the
 * registry that hosts the actor, with its endpoint, namespace and token. Put it into the actor's `layer`, and the
 * functions of `Client` work inside the actor without an endpoint of the product's. rivetkit keeps the client with
 * the actor's context and never disposes it, so this Layer does not either.
 */
export const client: Layer.Layer<Client.RivetClient, never, ActorEngine> = Layer.effect(
	Client.RivetClient,
	ActorEngine.use((engine) => engine.connect),
);
