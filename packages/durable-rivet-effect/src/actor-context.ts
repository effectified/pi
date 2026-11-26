// What this host provides to every Effect that runs inside an actor: the actor's identity, its database, its way to
// the engine, and Pi's storage on that database.

import type { SqliteDatabase } from "@effectified/pi-chord/sqlite";
import { type DurableError, Storage } from "@effectified/pi-durable";
import { Context, type Effect, Layer, type Option, type Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
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
export class ActorInfo extends Context.Service<ActorInfo, Identity>()("@effectified/pi-durable-rivet/ActorInfo") {}

/**
 * The actor's SQLite database as an Effect `SqlClient` of the SQLite dialect, on the one queue of the database, which
 * Pi's storage uses too: a product's or a plugin's own tables, with rows decoded by `SqlSchema`, migrations by
 * `Migrator` (with this client provided as `SqlClient`), and transactions that roll back when their Effect fails or
 * is interrupted. Name those tables outside the storage prefix. Rivet's transactions are its own, driven by Effect, and
 * a statement Rivet refuses with a retry hint is asked again only outside a transaction (README, "Storage").
 */
export class ActorSql extends Context.Service<ActorSql, SqlClient.SqlClient>()(
	"@effectified/pi-durable-rivet/ActorSql",
) {}

/**
 * The actor's SQLite database as Chord's `SqliteDatabase`, whose methods return promises: the adapter Pi's storage
 * runs on, on the queue `ActorSql` shares, so no transaction of either comes between the statements of another. For
 * code written against Chord's interface; new code uses `ActorSql`. `close` does nothing.
 *
 * @deprecated The promise form of `ActorSql`, kept for Pi's storage and for code written against it. Use `ActorSql`.
 */
export class ActorDatabase extends Context.Service<ActorDatabase, SqliteDatabase>()(
	"@effectified/pi-durable-rivet/ActorDatabase",
) {}

/**
 * The actor's way to the engine it runs on: `connect` makes Rivet's own client from the registry that hosts the
 * actor (the `c.client()` of rivetkit's actor context), with its endpoint, namespace and token. It is what
 * `Self.client` builds the `RivetClient` of an actor from, so actor code needs no endpoint of its own.
 */
export class ActorEngine extends Context.Service<ActorEngine, { readonly connect: Effect.Effect<ClientRaw> }>()(
	"@effectified/pi-durable-rivet/ActorEngine",
) {}

/** Options of `storage`. */
export interface StorageOptions {
	/** Namespaces Pi's tables and this host's own in the actor database. Changing it migrates nothing. */
	readonly prefix: string;
}

/**
 * Pi's SQLite storage on the actor's database, under `prefix`, on the `ActorDatabase` adapter, whose queue `ActorSql`
 * shares. Building it applies Pi's migrations. Pi's storage also passes its conformance suite on `Storage.sql` of
 * `@effectified/pi-durable` over `ActorSql`, which a product may use; that path measured slower (README, "Storage").
 */
export function storage(options: StorageOptions): Layer.Layer<Storage.HarnessStorage, DurableError, ActorDatabase> {
	// The adapter's `close` does nothing, so the storage closing it leaves the actor's database open.
	return Layer.unwrap(ActorDatabase.useSync((database) => Storage.sqlite(database, options)));
}
