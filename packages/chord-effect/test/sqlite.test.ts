import * as PiSqlite from "@earendil-works/chord/sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import { openNodeSqliteDatabase } from "../src/node/sqlite.ts";
import { applySqliteMigrations, InvalidSchemaPrefix, SqliteError, validateSqliteSchemaPrefix } from "../src/sqlite.ts";
import { run } from "./run.ts";

const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** What `@effectified/pi-chord/sqlite` does with every value Chord's `/sqlite` exports. */
const COVERAGE = {
	validateSqliteSchemaPrefix: replaced(
		"validateSqliteSchemaPrefix: an Effect that fails with InvalidSchemaPrefix where Chord throws",
	),
	applySqliteMigrations: replaced(
		"applySqliteMigrations: an Effect that fails with InvalidSchemaPrefix or SqliteError",
	),
} satisfies Record<keyof typeof PiSqlite, Coverage>;

const MIGRATIONS = [
	{ version: 1, statements: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT"] },
	{ version: 2, statements: ["ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"] },
];

describe("the coverage of Chord's /sqlite", () => {
	it("records every value", () => {
		expect(Object.keys(COVERAGE).sort()).toEqual(Object.keys(PiSqlite).sort());
	});
});

describe("validateSqliteSchemaPrefix", () => {
	it("accepts an identifier and fails with InvalidSchemaPrefix for one Chord refuses", async () => {
		const results = await Effect.runPromise(
			Effect.all(
				["app_", "1app", "app-x", "sqlite_app", "SQLITE_x"].map((prefix) =>
					Effect.match(validateSqliteSchemaPrefix(prefix), { onSuccess: () => "ok", onFailure: (error) => error }),
				),
			),
		);
		expect(results[0]).toBe("ok");
		expect(results.slice(1).every((result) => result instanceof InvalidSchemaPrefix)).toBe(true);
		expect(
			results.slice(1).map((result) => (result instanceof InvalidSchemaPrefix ? result.prefix : result)),
		).toEqual(["1app", "app-x", "sqlite_app", "SQLITE_x"]);
	});
});

describe("applySqliteMigrations", () => {
	it("applies the pending migrations once, and records their version", async () => {
		const rows = await run(
			Effect.gen(function* () {
				const database = yield* openNodeSqliteDatabase(":memory:");
				yield* applySqliteMigrations(database, MIGRATIONS.slice(0, 1), { table: "app_schema" });
				yield* applySqliteMigrations(database, MIGRATIONS, { table: "app_schema" });
				yield* applySqliteMigrations(database, MIGRATIONS, { table: "app_schema" });
				yield* Effect.promise(() => database.run("INSERT INTO notes (body, pinned) VALUES (?, ?)", "hello", 1));
				return yield* Effect.promise(() =>
					Promise.all([
						database.all<{ body: string; pinned: number }>("SELECT body, pinned FROM notes"),
						database.get<{ version: number }>("SELECT version FROM app_schema"),
					]),
				);
			}),
		);
		expect(rows).toEqual([[{ body: "hello", pinned: 1 }], { version: 2 }]);
	});

	it("fails with InvalidSchemaPrefix for a table name Chord refuses, before touching the database", async () => {
		const error = await run(
			Effect.gen(function* () {
				const database = yield* openNodeSqliteDatabase(":memory:");
				return yield* Effect.flip(applySqliteMigrations(database, MIGRATIONS, { table: "sqlite_schema" }));
			}),
		);
		expect(error).toBeInstanceOf(InvalidSchemaPrefix);
	});

	it("fails with SqliteError for what Chord rejects: a version gap, a newer database, a bad statement", async () => {
		const errors = await run(
			Effect.gen(function* () {
				const database = yield* openNodeSqliteDatabase(":memory:");
				const gap = yield* Effect.flip(applySqliteMigrations(database, [MIGRATIONS[1]], { table: "app_schema" }));
				yield* applySqliteMigrations(database, MIGRATIONS, { table: "app_schema" });
				const newer = yield* Effect.flip(
					applySqliteMigrations(database, MIGRATIONS.slice(0, 1), { table: "app_schema" }),
				);
				const broken = yield* Effect.flip(
					applySqliteMigrations(database, [...MIGRATIONS, { version: 3, statements: ["NOT SQL"] }], {
						table: "app_schema",
					}),
				);
				return [gap, newer, broken];
			}),
		);
		expect(errors.every((error) => error instanceof SqliteError)).toBe(true);
		expect(errors.map((error) => error.message.slice(0, 40))).toEqual([
			"SQLite migrations must have contiguous v",
			"SQLite schema version 2 is newer than su",
			expect.stringContaining("syntax error"),
		]);
	});
});
