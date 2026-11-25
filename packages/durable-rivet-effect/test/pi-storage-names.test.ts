// The host's own table beside Pi's storage in one actor database: the fork record's table sits under the prefix Pi's
// storage uses, and `CREATE TABLE IF NOT EXISTS` would quietly reuse a Pi table of the same name. Pi does not export
// its table and index names, only its migrations: the migrations are applied, and every name they make is held apart
// from what the host makes.

import { applySqliteMigrations, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import * as ForkRecord from "../src/fork-record.ts";
import * as SqliteDatabase from "../src/sqlite-database.ts";
import { type StandIn, sqlOver, standIn } from "./raw-stand-in.ts";

// The prefix an actor of this host gives Pi's storage when its config names none (`actor.ts`).
const PREFIX = "pi_";

/** The names of every table and index in the database, SQLite's own left out. */
const names = (database: StandIn) =>
	Effect.map(
		Effect.promise(() => database.raw.execute("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")),
		(rows) => new Set(rows.map(({ name }) => String(name))),
	);

/** The names the host's fork record makes in a fresh database under `prefix`. */
const hostNames = (prefix: string) =>
	Effect.gen(function* () {
		const database = standIn();
		yield* ForkRecord.record(yield* sqlOver(database.raw), prefix);
		return yield* names(database);
	});

describe("the host's tables beside Pi's storage", () => {
	it("makes no table or index whose name Pi's migrations make", () =>
		runTest(
			Effect.gen(function* () {
				const pi = standIn();
				yield* Effect.promise(() => applySqliteMigrations(SqliteDatabase.make(pi.raw)));
				const piNames = yield* names(pi);
				expect(piNames.size).toBeGreaterThan(0);
				const ours = yield* hostNames(PREFIX);
				expect(ours.size).toBeGreaterThan(0);
				// Pi's migrations make their names without a prefix; under a prefix every one of them gets it.
				const ourUnprefixed = [...ours].map((name) => {
					expect(name.startsWith(PREFIX), name).toBe(true);
					return name.slice(PREFIX.length);
				});
				expect(ourUnprefixed.filter((name) => piNames.has(name))).toEqual([]);
			}),
		));

	it("keeps its table apart from Pi's storage opened under the same prefix in the same database", () =>
		runTest(
			Effect.gen(function* () {
				const shared = standIn();
				yield* Effect.promise(() => SqliteStorage.open(SqliteDatabase.make(shared.raw), { prefix: PREFIX }));
				const piNames = yield* names(shared);
				// Pi prefixes every name it makes: the comparison of the test above holds for any prefix.
				const unprefixed = standIn();
				yield* Effect.promise(() => applySqliteMigrations(SqliteDatabase.make(unprefixed.raw)));
				expect(piNames).toEqual(new Set([...(yield* names(unprefixed))].map((name) => `${PREFIX}${name}`)));
				yield* ForkRecord.record(yield* sqlOver(shared.raw), PREFIX);
				const added = [...(yield* names(shared))].filter((name) => !piNames.has(name));
				expect(added).toEqual([...(yield* hostNames(PREFIX))]);
			}),
		));
});
