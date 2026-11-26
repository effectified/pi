// `@effectified/pi-durable/storage/sqlite/cloudflare`: Pi's SQLite storage in a SQLite-backed Durable Object, as a
// storage Layer.

import {
	DurableObjectSqliteDatabase,
	type DurableObjectSqliteStorage,
	openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { SqliteDatabase } from "@effectified/pi-chord/sqlite";
import { Effect, type Layer } from "effect";
import { call } from "../../call.ts";
import type { DurableError } from "../../errors.ts";
import { custom, type HarnessStorage, type SqlOptions } from "../../storage.ts";

export type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

/**
 * Pi's SQLite storage in the Durable Object whose `ctx.storage` is `storage`, under `options.prefix` when given.
 * Building it applies Pi's migrations. Storages opened on the same object share one queue of operations.
 */
export function durableObject(
	storage: DurableObjectSqliteStorage,
	options?: SqlOptions,
): Layer.Layer<HarnessStorage, DurableError> {
	return custom(call(() => openDurableObjectSqliteStorage(storage, options)));
}

/**
 * Chord's `SqliteDatabase` on the Durable Object whose `ctx.storage` is `storage` (Chord's
 * `DurableObjectSqliteDatabase`), for tables of your own beside Pi's, or `sqlite` of
 * `@effectified/pi-durable/storage/sqlite`. It shares the object's queue of operations with `durableObject`.
 */
export function database(storage: DurableObjectSqliteStorage): Effect.Effect<SqliteDatabase> {
	return Effect.sync(() => new DurableObjectSqliteDatabase(storage));
}
