// Test helper: a stand-in for the raw database of `rivetkit/db`, over one `node:sqlite` connection, with its interface
// and none of its help: `execute` gives rows as objects and takes several statements when it has no bindings, every
// call is asynchronous, and nothing is queued. A statement issued while a transaction is open would join it, and a
// second transaction would fail, so the stand-in counts both: an adapter that queues leaves the counts at zero.
// Rivet 3.1.1 is kinder (it isolates a transaction) but does not queue either: engine-suite.ts checks the real one.
// `refusingStorage` puts a stand-in behind a storage that refuses with Rivet's own refusal (`refusal`), and `sqlOver`
// is the host's `SqlClient` over a stand-in.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, FiberSet, type Scope, Semaphore } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { RivetError } from "rivetkit/client";
import * as Sql from "../src/actor-sql.ts";
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

/** The host's `SqlClient` over `raw`, on a queue of its own and a set of fibers of the scope. */
export function sqlOver(raw: RawDatabase): Effect.Effect<SqlClient.SqlClient, never, Scope.Scope> {
	return Effect.flatMap(Effect.all([Semaphore.make(1), FiberSet.make()]), ([queue, work]) =>
		Sql.make(raw, queue, work),
	);
}

/** Rivet's refusal, with the hint it gives while a volume changes hands, as it was caught on a local engine. */
export function refusal(group = "depot", hint = 100): RivetError {
	return new RivetError(
		group,
		"overloaded",
		`The storage host refused the command (volume_transition); retry after ${hint} ms.`,
		{ metadata: { reason: "volume_transition", retry_after_ms: hint } },
	);
}

/** What a refusing database refuses: the next so many of each kind of request. */
export interface Refusals {
	/** Statements on the database itself. */
	readonly statements?: number;
	/** Transactions, before their callback is called. */
	readonly begins?: number;
	/** Statements inside a transaction. */
	readonly inside?: number;
}

/** What a refusing database was asked for, refused requests included. */
export interface Asked {
	statements: number;
	transactions: number;
}

/**
 * `raw` behind a storage that refuses with `refused()` what `refuse` says, as Rivet's storage refuses while a volume
 * changes hands: a refused request does nothing.
 */
export function refusingStorage(
	raw: RawDatabase,
	refuse: Refusals,
	refused: () => unknown,
): { readonly raw: RawDatabase; readonly asked: Asked } {
	const left = { statements: refuse.statements ?? 0, begins: refuse.begins ?? 0, inside: refuse.inside ?? 0 };
	const asked: Asked = { statements: 0, transactions: 0 };
	const take = (kind: keyof typeof left): boolean => {
		if (left[kind] <= 0) return false;
		left[kind] -= 1;
		return true;
	};
	return {
		asked,
		raw: {
			execute: (query, ...args) => {
				asked.statements += 1;
				return take("statements") ? Promise.reject(refused()) : raw.execute(query, ...args);
			},
			transaction: (callback, options) => {
				asked.transactions += 1;
				if (take("begins")) return Promise.reject(refused());
				return raw.transaction(
					(transaction) =>
						callback({
							execute: (query, ...args) =>
								take("inside") ? Promise.reject(refused()) : transaction.execute(query, ...args),
							transaction: (nested, nestedOptions) => transaction.transaction(nested, nestedOptions),
						}),
					options,
				);
			},
		},
	};
}
