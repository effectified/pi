// `@effectified/pi-chord/sqlite/cloudflare`: Chord's SQLite database on a SQLite-backed Durable Object's storage.

import { DurableObjectSqliteDatabase, type DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";
import { Effect } from "effect";

// Chord's Durable Object types (`DurableObjectSqliteStorage`, the structural binding of `ctx.storage`).
export type * from "@earendil-works/chord/sqlite/cloudflare";

/**
 * Chord's `DurableObjectSqliteDatabase` on the Durable Object whose `ctx.storage` is `storage`: a `SqliteDatabase` for
 * `applySqliteMigrations` of `@effectified/pi-chord/sqlite` or Pi's SQLite storage. Its operations run one after
 * another on the object's queue; the object owns the storage, so there is nothing to close. Chord's store does not
 * open on it in Chord 1.6.1: its schema check (`PRAGMA encoding`) is not authorized in workerd.
 */
export function database(storage: DurableObjectSqliteStorage): Effect.Effect<DurableObjectSqliteDatabase> {
	return Effect.sync(() => new DurableObjectSqliteDatabase(storage));
}
