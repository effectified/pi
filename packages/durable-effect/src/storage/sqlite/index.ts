// `@effectified/pi-durable/storage/sqlite`: Pi's SQLite storage on a Chord `SqliteDatabase` as a storage Layer, and its
// migrations.

import { applySqliteMigrations, type SqliteMigration } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase } from "@effectified/pi-chord/sqlite";
import type { Effect } from "effect";
import { call } from "../../call.ts";
import type { DurableError } from "../../errors.ts";

export type { SqliteMigration, SqliteStorageOptions } from "@earendil-works/pi-durable/storage/sqlite";
// Pi's schema version and migrations: plain values.
export { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
export { type SqlOptions, sqlite } from "../../storage.ts";

/**
 * Applies Pi's migrations (or `migrations`) to `database`, under no table prefix, without opening a storage: what
 * opening `sqlite` does first. Each one not applied yet runs once, in order.
 */
export function applyMigrations(
	database: SqliteDatabase,
	migrations?: ReadonlyArray<SqliteMigration>,
): Effect.Effect<void, DurableError> {
	return call(() => applySqliteMigrations(database, migrations));
}
