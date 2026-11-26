// Test helper: the suites that need a real SQLite `SqlClient`, registered once per driver by a platform test file:
// the `SqliteDatabase` adapter (src/sql-database.ts), Pi's storage conformance on `Storage.sql` and on
// `Storage.sqlite`, a reopen, the
// kill-and-resume suites of a run (kill-resume.ts) and of a task (task-kill-resume.ts), a gate parked across a reopen
// (parked-gate.ts), a review task across a reopen (review-reopen.ts), a keyed fork across a crash
// (keyed-fork-crash.ts) and the testing kit's SQLite storage across a reopen (kit-restart.ts).

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import {
	createExpectAssertions,
	registerStorageConformance,
	type StorageConformanceRunner,
} from "@earendil-works/pi-durable/testing";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Storage } from "../src/index.ts";
import * as SqlDatabase from "../src/sql-database.ts";
import { registerKeyedForkCrash } from "./keyed-fork-crash.ts";
import { registerKillResume } from "./kill-resume.ts";
import { registerKitRestart } from "./kit-restart.ts";
import { reopenWithPendingSubmission } from "./lifecycle.ts";
import { registerParkedGate } from "./parked-gate.ts";
import { registerReviewReopen } from "./review-reopen.ts";
import { registerTaskKillResume } from "./task-kill-resume.ts";

/** Opens the driver's client on a database file, or on `":memory:"`. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

/** Runs `use` with the path of a database file that is removed afterwards. */
export type WithDatabaseFile = <A>(use: (filename: string) => Promise<A>) => Promise<A>;

/**
 * Copies a database file as it is on disk now, with its write-ahead log, to a path beside it: what a process that died
 * at this moment leaves behind, `running` tasks included.
 */
export type CopyDatabaseFile = (from: string, to: string) => void;

/** Registers every SQLite suite for one driver. `runner.describe` skips them on the other runtime. */
export function registerSqliteSuites(runner: StorageConformanceRunner, driver: string, client: ClientLayer): void {
	registerDatabaseSuite(runner, driver, client);
	registerStorageConformance(runner, `Storage.sql conformance (${driver})`, (use) =>
		Effect.runPromise(
			Storage.HarnessStorage.use((storage) => Effect.promise(() => use(storage))).pipe(
				Effect.provide(Storage.sql()),
				Effect.provide(client(":memory:")),
			),
		),
	);
	registerStorageConformance(runner, `Storage.sql conformance with a prefix, on a file (${driver})`, (use) =>
		withDatabaseFile((filename) =>
			Effect.runPromise(
				Storage.HarnessStorage.use((storage) => Effect.promise(() => use(storage))).pipe(
					Effect.provide(Storage.sql({ prefix: "pi_" })),
					Effect.provide(client(filename)),
				),
			),
		),
	);
	registerStorageConformance(runner, `Storage.sqlite conformance on a Chord database (${driver})`, (use) =>
		Effect.runPromise(
			Effect.flatMap(SqlDatabase.make, (database) =>
				Storage.HarnessStorage.use((storage) => Effect.promise(() => use(storage))).pipe(
					Effect.provide(Storage.sqlite(database, { prefix: "chord_" })),
				),
			).pipe(Effect.provide(client(":memory:"))),
		),
	);
	registerStorageSuite(runner, driver, client);
	registerKillResume(runner, driver, client, withDatabaseFile);
	registerParkedGate(runner, driver, client, withDatabaseFile);
	registerTaskKillResume(runner, driver, client, withDatabaseFile, copyDatabaseFile);
	registerReviewReopen(runner, driver, client, withDatabaseFile);
	registerKeyedForkCrash(runner, driver, client, withDatabaseFile, copyDatabaseFile);
	registerKitRestart(runner, driver, client, withDatabaseFile);
}

function registerDatabaseSuite(runner: StorageConformanceRunner, driver: string, client: ClientLayer): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	/** Runs `use` with the adapter over a fresh in-memory database holding one table, and with the client itself. */
	const withDatabase = <A>(use: (database: SqliteDatabase, sql: SqlClient) => Promise<A>): Promise<A> =>
		Effect.runPromise(
			Effect.gen(function* () {
				const database = yield* SqlDatabase.make;
				const sql = yield* SqlClient;
				yield* Effect.promise(() =>
					database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT, data BLOB)"),
				);
				return yield* Effect.promise(() => use(database, sql));
			}).pipe(Effect.provide(client(":memory:"))),
		);
	const texts = async (executor: SqliteExecutor) =>
		(await executor.all<{ text: string }>("SELECT text FROM notes ORDER BY id")).map((row) => row.text);

	describe(`SqliteDatabase over SqlClient (${driver})`, () => {
		it("runs statements with positional bindings and reads rows back", () =>
			withDatabase(async (database) => {
				await database.run(
					"INSERT INTO notes (id, text, data) VALUES (?, ?, ?)",
					1,
					"first",
					new Uint8Array([1, 2]),
				);
				await database.run("INSERT INTO notes (id, text, data) VALUES (?, ?, ?)", 2, "second", null);
				const first = await database.get<{ id: number; text: string; data: Uint8Array }>(
					"SELECT id, text, data FROM notes WHERE id = ?",
					1,
				);
				assert.deepEqual({ ...first, data: [...(first?.data ?? [])] }, { id: 1, text: "first", data: [1, 2] });
				assert.strictEqual(await database.get("SELECT id FROM notes WHERE id = ?", 9), undefined);
				assert.deepEqual(await texts(database), ["first", "second"]);
			}));

		it("counts the rows a statement changed, on the database and inside a transaction", () =>
			withDatabase(async (database) => {
				await database.run("INSERT INTO notes (id, text) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
				assert.strictEqual(await database.runCounted("UPDATE notes SET text = ? WHERE id > ?", "z", 1), 2);
				assert.strictEqual(await database.runCounted("DELETE FROM notes WHERE id = ?", 9), 0);
				const counted = await database.transaction((transaction) =>
					transaction.runCounted("DELETE FROM notes WHERE text = ?", "z"),
				);
				assert.strictEqual(counted, 2);
				assert.deepEqual(await texts(database), ["a"]);
			}));

		it("commits a transaction and resolves with what its callback returned", () =>
			withDatabase(async (database) => {
				const seen = await database.transaction(async (transaction) => {
					await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "kept");
					return texts(transaction);
				});
				assert.deepEqual(seen, ["kept"]);
				assert.deepEqual(await texts(database), ["kept"]);
			}));

		it("rolls a transaction back and rejects with the callback's own error", () =>
			withDatabase(async (database) => {
				const failure = new Error("callback failed");
				const rejected = await database
					.transaction(async (transaction) => {
						await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "dropped");
						throw failure;
					})
					.catch((error: unknown) => error);
				assert.strictEqual(rejected, failure);
				assert.deepEqual(await texts(database), []);
			}));

		it("holds other statements until a transaction has finished", () =>
			withDatabase(async (database) => {
				const order: string[] = [];
				const sent = Promise.withResolvers<void>();
				const transaction = database.transaction(async (handle) => {
					await handle.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "inside");
					await sent.promise;
					// Sent after the outside statement: on the one connection it would wait for that one, were it not held.
					await handle.run("INSERT INTO notes (id, text) VALUES (?, ?)", 3, "later");
					order.push("transaction");
				});
				const outside = database
					.run("INSERT INTO notes (id, text) VALUES (?, ?)", 2, "outside")
					.then(() => order.push("outside"));
				sent.resolve();
				await Promise.all([transaction, outside]);
				assert.deepEqual(order, ["transaction", "outside"]);
				assert.deepEqual(await texts(database), ["inside", "outside", "later"]);
			}));

		it("rejects a transaction handle used after its transaction ended", () =>
			withDatabase(async (database) => {
				let kept: SqliteExecutor | undefined;
				await database.transaction(async (transaction) => {
					kept = transaction;
				});
				await assert.rejects(
					kept!.run("INSERT INTO notes (id, text) VALUES (1, 'late')"),
					"the transaction has already ended",
				);
				assert.deepEqual(await texts(database), []);
			}));

		it("rejects with the client's SqlError for a statement SQLite refuses", () =>
			withDatabase(async (database) => {
				const rejected = await database.run("INSERT INTO missing (id) VALUES (1)").catch((error: unknown) => error);
				assert.partialDeepEqual(rejected, { _tag: "SqlError" });
			}));

		it("shares the connection with the program's own SQL, and leaves the client open on close", () =>
			withDatabase(async (database, sql) => {
				await database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "from pi");
				await Effect.runPromise(sql`INSERT INTO notes (id, text) VALUES (2, 'from the host')`);
				await database.close();
				const rows = await Effect.runPromise(sql<{ text: string }>`SELECT text FROM notes ORDER BY id`);
				assert.deepEqual(
					rows.map((row) => row.text),
					["from pi", "from the host"],
				);
			}));
	});
}

function registerStorageSuite(runner: StorageConformanceRunner, driver: string, client: ClientLayer): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	describe(`Storage.sql (${driver})`, () => {
		it("resumes a pending submission when it reopens the same SQLite file", () =>
			withDatabaseFile(async (filename) => {
				const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
				const result = await reopenWithPendingSubmission(storage, {});
				assert.partialDeepEqual(result.unprompted, { requestId: "pending", status: "done" });
				assert.deepEqual([result.firstCalls, result.secondCalls], [1, 1]);
			}));

		it("namespaces Pi's tables with the prefix, next to the host's own", () =>
			withDatabaseFile((filename) =>
				Effect.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient;
						yield* sql`CREATE TABLE host_notes (text TEXT)`;
						yield* Storage.HarnessStorage.use((storage) => Effect.promise(() => storage.mintId())).pipe(
							Effect.provide(Storage.sql({ prefix: "pi_" })),
						);
						const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
						const names = tables.map((table) => table.name);
						assert.ok(names.includes("host_notes"));
						assert.ok(names.includes("pi_entries"));
						assert.ok(!names.includes("entries"));
					}).pipe(Effect.provide(client(filename))),
				),
			));
	});
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-durable-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Copies the database file `from` and the files SQLite keeps beside it to `to`. */
function copyDatabaseFile(from: string, to: string): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
	}
}
