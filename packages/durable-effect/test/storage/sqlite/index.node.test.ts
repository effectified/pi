import { openNodeSqliteDatabase } from "@effectified/pi-chord/sqlite/node";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Storage } from "../../../src/index.ts";
import { applyMigrations, CURRENT_SQLITE_SCHEMA_VERSION, sqlite } from "../../../src/storage/sqlite/index.ts";
import { storageConformance } from "../../../src/testing/index.ts";

/** The database refused a statement after the storage closed it. */
class Closed extends Schema.TaggedError<Closed, { readonly brand: unique symbol }>()("Closed", {
	cause: Schema.Defect(),
}) {}

/** Pi's SQLite storage on a Chord database in memory, made for each build. */
const inMemory = Layer.unwrap(Effect.map(openNodeSqliteDatabase(":memory:"), (database) => sqlite(database)));

// Node's built-in SQLite (`node:sqlite`): the Node lane only.
describe.skipIf("Bun" in globalThis)("sqlite on a Chord database", () => {
	it("is Storage.sqlite", () => {
		expect(sqlite).toBe(Storage.sqlite);
	});

	it("applyMigrations brings a database to Pi's schema, once", async () => {
		const tables = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const database = yield* openNodeSqliteDatabase(":memory:");
					const before = yield* Effect.promise(() =>
						database.all("SELECT name FROM sqlite_master WHERE type = 'table'"),
					);
					yield* applyMigrations(database);
					// Applied twice, the second does nothing.
					yield* applyMigrations(database);
					const after = yield* Effect.promise(() =>
						database.all("SELECT name FROM sqlite_master WHERE type = 'table'"),
					);
					return { before: before.length, after: after.length };
				}),
			),
		);
		expect(tables.before).toBe(0);
		expect(tables.after).toBeGreaterThan(0);
		expect(CURRENT_SQLITE_SCHEMA_VERSION).toBeGreaterThan(0);
	});

	describe("Pi's storage conformance", () => {
		for (const testCase of Effect.runSync(storageConformance(inMemory, expect))) {
			it(testCase.name, () => Effect.runPromise(testCase.run));
		}
	});

	it("closes the database with the storage", async () => {
		const closed = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const database = yield* openNodeSqliteDatabase(":memory:");
					yield* Effect.scoped(Layer.build(sqlite(database)));
					return yield* Effect.exit(
						Effect.tryPromise({ try: () => database.get("SELECT 1"), catch: (cause) => Closed.make({ cause }) }),
					);
				}),
			),
		);
		expect(closed._tag).toBe("Failure");
	});
});
