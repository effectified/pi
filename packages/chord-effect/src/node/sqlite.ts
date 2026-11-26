// `@effectified/pi-chord/sqlite/node`: a SQLite file on Node's `node:sqlite`, opened for the life of a scope.

import {
	type NodeSqliteDatabase,
	type NodeSqliteDatabaseOptions,
	openNodeSqliteDatabase as piOpenNodeSqliteDatabase,
} from "@earendil-works/chord/sqlite/node";
import { Effect, type Scope } from "effect";
import type { SqliteError } from "../errors.ts";
import { settled } from "../settled.ts";

// Chord's Node SQLite types (`NodeSqliteDatabase`, `NodeSqliteDatabaseOptions`, `NodeSqliteMode`).
export type * from "@earendil-works/chord/sqlite/node";
export { SqliteError } from "../errors.ts";

/**
 * Chord's Node SQLite database at `path` (`":memory:"` for one in memory), closed when the scope closes. The value is
 * Chord's own `SqliteDatabase`: hand it to what takes one, such as Pi Durable's SQLite storage. In `read-write` mode
 * (the default) the file's directory is made and the file is put in WAL mode. Fails with `SqliteError` when the file
 * cannot be opened or configured.
 */
export function openNodeSqliteDatabase(
	path: string,
	options?: NodeSqliteDatabaseOptions,
): Effect.Effect<NodeSqliteDatabase, SqliteError, Scope.Scope> {
	return Effect.acquireRelease(
		settled(() => piOpenNodeSqliteDatabase(path, options)),
		// A close that fails leaves nothing to recover in a finalizer: Chord closes the connection whatever it says.
		(database) => Effect.ignore(settled(() => database.close())),
	);
}
