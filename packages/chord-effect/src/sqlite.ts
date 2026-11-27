// `@effectified/pi-chord/sqlite`: the SQLite database Chord and Pi's storages share, its prefix rule and migrations.

import {
	applySqliteMigrations as piApplySqliteMigrations,
	validateSqliteSchemaPrefix as piValidateSqliteSchemaPrefix,
	type SqliteDatabase,
	type SqliteMigration,
} from "@earendil-works/chord/sqlite";
import { Effect, Predicate } from "effect";
import { InvalidSchemaPrefix, type SqliteError } from "./errors.ts";
import { settled } from "./settled.ts";

// Chord's SQLite types: `SqliteDatabase` (what Pi's SQLite storages open), `SqliteExecutor`, `SqliteValue`,
// `SqliteMigration`.
export type * from "@earendil-works/chord/sqlite";
export { InvalidSchemaPrefix, SqliteError } from "./errors.ts";

/**
 * Chord's rule for a prefix that becomes part of a SQLite identifier, the one Pi's storages apply to their table
 * prefix: an identifier (`[A-Za-z_][A-Za-z0-9_]*`) that does not start with SQLite's reserved `sqlite_`. Fails with
 * `InvalidSchemaPrefix` where Chord throws.
 */
export function validateSqliteSchemaPrefix(prefix: string): Effect.Effect<void, InvalidSchemaPrefix> {
	return Effect.try({
		try: () => piValidateSqliteSchemaPrefix(prefix),
		// Chord's validator throws only an `Error` that names the prefix.
		catch: (thrown) =>
			InvalidSchemaPrefix.make({ prefix, message: Predicate.isError(thrown) ? thrown.message : String(thrown) }),
	});
}

/**
 * Chord's migrations: applies, in one transaction, every migration newer than the version recorded in the metadata
 * table `options.table`. Fails with `InvalidSchemaPrefix` for a table name that is not a prefix Chord accepts, and
 * with `SqliteError` for whatever Chord or the database rejects with (versions that are not 1, 2, 3, ..., a database
 * newer than the migrations, a failed statement). Chord takes no signal: an interrupted fiber waits until the
 * transaction committed or rolled back.
 */
export function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[],
	options: Parameters<typeof piApplySqliteMigrations>[2],
): Effect.Effect<void, InvalidSchemaPrefix | SqliteError> {
	return Effect.andThen(
		validateSqliteSchemaPrefix(options.table),
		settled(() => piApplySqliteMigrations(database, migrations, options)),
	);
}
