// The SQLite adapter without an engine: over a stand-in with the raw database's interface that queues nothing
// (raw-stand-in.ts), so the queueing seen here is the adapter's own. The same contract is checked on a real actor
// database in engine-suite.ts.

import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import * as Database from "../src/sqlite-database.ts";
import { type StandIn, standIn } from "./raw-stand-in.ts";

/** The adapter over a fresh stand-in holding one table. */
async function notes(): Promise<StandIn & { readonly database: SqliteDatabase }> {
	const fresh = standIn();
	const database = Database.make(fresh.raw);
	await database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
	return { ...fresh, database };
}

const texts = async (executor: SqliteExecutor): Promise<string[]> =>
	(await executor.all<{ text: string }>("SELECT text FROM notes ORDER BY id")).map((row) => row.text);

describe("SqliteDatabase over a raw actor database", () => {
	it("runs statements with positional bindings and reads rows back", async () => {
		const { database } = await notes();
		await database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "first");
		await database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 2, "second");
		expect(await database.get("SELECT id, text FROM notes WHERE id = ?", 1)).toEqual({ id: 1, text: "first" });
		expect(await database.get("SELECT id FROM notes WHERE id = ?", 9)).toBeUndefined();
		expect(await texts(database)).toEqual(["first", "second"]);
	});

	it("runs several statements in one exec", async () => {
		const { database } = await notes();
		await database.exec("INSERT INTO notes (text) VALUES ('a'); INSERT INTO notes (text) VALUES ('b')");
		expect(await texts(database)).toEqual(["a", "b"]);
	});

	it("counts the rows a statement changed, on the database and inside a transaction", async () => {
		const { database } = await notes();
		await database.run("INSERT INTO notes (id, text) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
		expect(await database.runCounted("UPDATE notes SET text = ? WHERE id > ?", "z", 1)).toBe(2);
		expect(await database.runCounted("DELETE FROM notes WHERE id = ?", 9)).toBe(0);
		expect(
			await database.transaction((transaction) => transaction.runCounted("DELETE FROM notes WHERE text = ?", "z")),
		).toBe(2);
		expect(await texts(database)).toEqual(["a"]);
	});

	it("keeps another caller's statement from coming between a statement and its count", async () => {
		const { database, overlaps } = await notes();
		await database.run("INSERT INTO notes (id, text) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
		// Issued together: without a transaction around the count, it would read the insert's one row.
		const [counted] = await Promise.all([
			database.runCounted("UPDATE notes SET text = 'z'"),
			database.run("INSERT INTO notes (id, text) VALUES (4, 'd')"),
		]);
		expect(counted).toBe(3);
		expect(await texts(database)).toEqual(["z", "z", "z", "d"]);
		expect(overlaps()).toBe(0);
	});

	it("commits a transaction and resolves with what its callback returned", async () => {
		const { database } = await notes();
		const seen = await database.transaction(async (transaction) => {
			await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "kept");
			return texts(transaction);
		});
		expect(seen).toEqual(["kept"]);
		expect(await texts(database)).toEqual(["kept"]);
	});

	it("rolls a transaction back and rejects with the callback's own error", async () => {
		const { database } = await notes();
		const failure = new Error("callback failed");
		const rejected = await database
			.transaction(async (transaction) => {
				await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "dropped");
				throw failure;
			})
			.catch((error: unknown) => error);
		expect(rejected).toBe(failure);
		expect(await texts(database)).toEqual([]);
	});

	it("lets a statement into an open transaction when the raw database is used without the adapter", async () => {
		const { raw, overlaps } = standIn();
		await raw.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
		const gate = Promise.withResolvers<void>();
		const open = raw.transaction(() => gate.promise);
		await raw.execute("INSERT INTO notes (id, text) VALUES (1, 'joined')");
		gate.resolve();
		await open;
		// What the adapter's queue is for: the tests below leave this count at zero.
		expect(overlaps()).toBe(1);
	});

	it("holds other statements and transactions until a transaction has finished", async () => {
		const { database, overlaps } = await notes();
		const started: string[] = [];
		const gate = Promise.withResolvers<void>();
		const first = database.transaction(async (transaction) => {
			await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "inside");
			await gate.promise;
		});
		const outside = database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 2, "outside").then(() => {
			started.push("statement");
		});
		// What the second transaction finds when it starts: everything issued before it.
		const second = database.transaction((transaction) => {
			started.push("second transaction");
			return texts(transaction);
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toEqual([]);
		gate.resolve();
		expect(await second).toEqual(["inside", "outside"]);
		await Promise.all([first, outside]);
		expect(started).toEqual(["statement", "second transaction"]);
		expect(overlaps()).toBe(0);
	});

	it("runs what was asked for after a failed operation", async () => {
		const { database } = await notes();
		const failed = database.run("INSERT INTO missing (id) VALUES (1)").catch(() => "rejected");
		const after = database.run("INSERT INTO notes (id, text) VALUES (1, 'after')");
		expect(await failed).toBe("rejected");
		await after;
		expect(await texts(database)).toEqual(["after"]);
	});

	it("rejects a transaction handle used after its transaction ended", async () => {
		const { database } = await notes();
		let kept: SqliteExecutor | undefined;
		await database.transaction(async (transaction) => {
			kept = transaction;
		});
		await expect(kept?.run("INSERT INTO notes (id, text) VALUES (1, 'late')")).rejects.toThrow("already committed");
		expect(await texts(database)).toEqual([]);
	});

	it("costs one statement for run and two for runCounted, and closes nothing", async () => {
		const { database, statements } = await notes();
		const before = statements();
		await database.run("INSERT INTO notes (id, text) VALUES (1, 'a')");
		expect(statements() - before).toBe(1);
		await database.runCounted("UPDATE notes SET text = 'b'");
		expect(statements() - before).toBe(3);
		await database.close();
		expect(await texts(database)).toEqual(["b"]);
	});
});

registerStorageConformance(
	{ describe, expect, it },
	"Pi's storage conformance on the adapter over the stand-in",
	async (use) => use(await SqliteStorage.open(Database.make(standIn().raw))),
);

registerStorageConformance(
	{ describe, expect, it },
	"Pi's storage conformance on the adapter over the stand-in, with a prefix",
	async (use) => use(await SqliteStorage.open(Database.make(standIn().raw), { prefix: "pi_" })),
);
