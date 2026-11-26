import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiNodeSqlite from "@earendil-works/chord/sqlite/node";
import { Effect, Exit, Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { Coverage } from "../../../../effect/conformance.ts";
import { openNodeSqliteDatabase, SqliteError } from "../../src/node/sqlite.ts";
import { run } from "../run.ts";

const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/sqlite/node` does with every value Chord's `/sqlite/node` exports. */
const COVERAGE = {
	openNodeSqliteDatabase: replaced("openNodeSqliteDatabase: scoped, closed when its scope closes"),
	NodeSqliteDatabase: replaced("openNodeSqliteDatabase, which gives one for the life of a scope"),
} satisfies Record<keyof typeof PiNodeSqlite, Coverage>;

const directory = mkdtempSync(join(tmpdir(), "pi-chord-effect-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("the coverage of Chord's /sqlite/node", () => {
	it("records both values", () => {
		expect(Object.keys(COVERAGE).sort()).toEqual(["NodeSqliteDatabase", "openNodeSqliteDatabase"]);
	});
});

describe("openNodeSqliteDatabase", () => {
	it("opens a file in a directory it makes, in WAL mode, and closes it with the scope", async () => {
		const path = join(directory, "nested", "app.db");
		const seen = await run(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const database = yield* Scope.provide(openNodeSqliteDatabase(path), scope);
				yield* Effect.promise(() => database.exec("CREATE TABLE notes (body TEXT) STRICT"));
				const mode = yield* Effect.promise(() => database.get<{ journal_mode: string }>("PRAGMA journal_mode"));
				yield* Scope.close(scope, Exit.void);
				const afterClose = yield* Effect.promise(() =>
					database.get("SELECT 1").then(
						() => "open",
						() => "closed",
					),
				);
				return { mode: mode?.journal_mode, afterClose };
			}),
		);
		expect(seen).toEqual({ mode: "wal", afterClose: "closed" });

		// The file outlived the connection: a new one reads what the first wrote. (Read-write: Bun's `node:sqlite` does
		// not open a WAL file read-only.)
		const tables = await run(
			Effect.gen(function* () {
				const database = yield* openNodeSqliteDatabase(path);
				return yield* Effect.promise(() => database.all<{ name: string }>("SELECT name FROM sqlite_master"));
			}),
		);
		expect(tables).toEqual([{ name: "notes" }]);
	});

	it("fails with SqliteError for a file it cannot open", async () => {
		const error = await run(
			Effect.flip(openNodeSqliteDatabase(join(directory, "missing.db"), { mode: "read-only" })),
		);
		expect(error).toBeInstanceOf(SqliteError);
	});
});
