// `@effectified/pi-durable/storage/sqlite/node`: Pi's SQLite storage on a file through Node's built-in SQLite, as a
// storage Layer.

import { type NodeSqliteStorageOptions, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Layer } from "effect";
import { call } from "../../call.ts";
import type { DurableError } from "../../errors.ts";
import { custom, type HarnessStorage } from "../../storage.ts";

export type { NodeSqliteStorageOptions } from "@earendil-works/pi-durable/storage/sqlite/node";
// Chord's Node SQLite database as a scoped resource, for `sqlite` of `@effectified/pi-durable/storage/sqlite`.
export { openNodeSqliteDatabase } from "@effectified/pi-chord/sqlite/node";

/**
 * Pi's SQLite storage in the file at `path`, created when absent, through Node's built-in SQLite (`node:sqlite`),
 * under `options.prefix` when given. Building it applies Pi's migrations; closing the harness or the Layer's scope
 * closes the file. Fails with `UnexpectedError` for an invalid prefix or a file that cannot be opened.
 */
export function nodeSqlite(
	path: string,
	options?: NodeSqliteStorageOptions,
): Layer.Layer<HarnessStorage, DurableError> {
	return custom(call(() => openNodeSqliteStorage(path, options)));
}
