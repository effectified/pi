// Test helper: a stand-in for the raw database of `rivetkit/db`, over one `node:sqlite` connection, with its interface
// and none of its help: `execute` gives rows as objects and takes several statements when it has no bindings, every
// call is asynchronous, and nothing is queued. A statement issued while a transaction is open would join it, and a
// second transaction would fail, so the stand-in counts both: an adapter that queues leaves the counts at zero.
// Rivet 3.1.1 is kinder (it isolates a transaction) but does not queue either: engine-suite.ts checks the real one.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RawDatabase } from "../src/sqlite-database.ts";

/** An in-memory stand-in database, and what it saw. */
export interface StandIn {
	readonly raw: RawDatabase;
	/** How many statements ran, a transaction's own included. */
	readonly statements: () => number;
	/** How many statements and transactions were issued on the database while a transaction was open. */
	readonly overlaps: () => number;
}

/** A fresh in-memory database behind Rivet's raw interface. */
export function standIn(): StandIn {
	const database = new DatabaseSync(":memory:");
	let statements = 0;
	let overlaps = 0;
	let open = false;
	const execute = (query: string, args: unknown[]): Record<string, unknown>[] => {
		statements += 1;
		if (args.length === 0 && query.trim().replace(/;+$/, "").includes(";")) {
			database.exec(query);
			return [];
		}
		// The adapter binds only what Chord's `SqliteValue` allows, which `node:sqlite` takes as it is.
		return database.prepare(query).all(...(args as SQLInputValue[])) as Record<string, unknown>[];
	};
	const raw: RawDatabase = {
		execute: async (query, ...args) => {
			await Promise.resolve();
			if (open) overlaps += 1;
			return execute(query, args);
		},
		transaction: async (callback) => {
			await Promise.resolve();
			if (open) {
				overlaps += 1;
				throw new Error("cannot start a transaction within a transaction");
			}
			open = true;
			database.exec("BEGIN IMMEDIATE");
			let ended = false;
			const handle: RawDatabase = {
				execute: async (query, ...args) => {
					if (ended) throw new Error("SQLite transaction handle is already committed.");
					return execute(query, args);
				},
				transaction: () => Promise.reject(new Error("nested transactions are not part of the stand-in")),
			};
			try {
				const result = await callback(handle);
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			} finally {
				ended = true;
				open = false;
			}
		},
	};
	return { raw, statements: () => statements, overlaps: () => overlaps };
}
