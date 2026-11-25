// What this host provides to every Effect that runs inside an actor: the actor's identity, its database, its way to
// the engine, and Pi's storage on that database.

import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { type DurableError, Storage, UnexpectedError } from "@gunta/pi-durable-effect";
import { Context, Effect, type Layer, type Option, type Schema } from "effect";
import type { ClientRaw } from "rivetkit/client";

/** One individual actor fork behind an actor: the source it was copied from, and when. */
export interface ForkLink {
	readonly actorId: string;
	readonly key: ReadonlyArray<string>;
	/** Epoch milliseconds on the engine's clock. */
	readonly forkedAt: number;
}

/** The identity of an actor, as Rivet gives it. */
export interface Identity {
	readonly actorId: string;
	/** The name the actor is registered under. */
	readonly name: string;
	readonly key: ReadonlyArray<string>;
	readonly namespace: string;
	/** The actor forks behind this actor, oldest first; empty when it was never forked. */
	readonly forkChain: ReadonlyArray<ForkLink>;
	/** The `input` the newest fork was made with; none for an actor that is not a fork, or a fork made without one. */
	readonly forkInput: Option.Option<Schema.Json>;
}

/** The actor an Effect runs in. Provided to the product's Layers, its actions and its fork hygiene. */
export class ActorInfo extends Context.Service<ActorInfo, Identity>()("@gunta/pi-durable-rivet-effect/ActorInfo") {}

/**
 * The actor's SQLite database as Chord's `SqliteDatabase`: the one adapter Pi's storage uses too, so a product that
 * keeps tables of its own in the actor shares its transactions' queue with Pi. Name those tables outside the storage
 * prefix. `close` does nothing.
 */
export class ActorDatabase extends Context.Service<ActorDatabase, SqliteDatabase>()(
	"@gunta/pi-durable-rivet-effect/ActorDatabase",
) {}

/**
 * The actor's way to the engine it runs on: `connect` makes Rivet's own client from the registry that hosts the
 * actor (the `c.client()` of rivetkit's actor context), with its endpoint, namespace and token. It is what
 * `Self.client` builds the `RivetClient` of an actor from, so actor code needs no endpoint of its own.
 */
export class ActorEngine extends Context.Service<ActorEngine, { readonly connect: Effect.Effect<ClientRaw> }>()(
	"@gunta/pi-durable-rivet-effect/ActorEngine",
) {}

/** Options of `storage`. */
export interface StorageOptions {
	/** Namespaces Pi's tables and this host's own in the actor database. Changing it migrates nothing. */
	readonly prefix: string;
}

/** Pi's SQLite storage on the actor's database, under `prefix`. Building it applies Pi's migrations. */
export function storage(options: StorageOptions): Layer.Layer<Storage.HarnessStorage, DurableError, ActorDatabase> {
	return Storage.custom(
		ActorDatabase.use((database) =>
			Effect.tryPromise({
				try: () => SqliteStorage.open(database, { prefix: options.prefix }),
				catch: (cause) => new UnexpectedError({ cause }),
			}),
		),
	);
}
