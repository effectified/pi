// Test fixture: a Worker with a SQLite-backed Durable Object that migrates, writes and reads Chord's database on its
// storage through this package.

import { Effect } from "effect";
import { type DurableObjectSqliteStorage, database } from "../../src/cloudflare/sqlite.ts";
import { applySqliteMigrations } from "../../src/sqlite.ts";

interface Env {
	readonly STORE: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

/** A SQLite-backed Durable Object with a table of its own, migrated by Chord. */
export class Store {
	readonly #storage: DurableObjectSqliteStorage;

	constructor(state: { readonly storage: DurableObjectSqliteStorage }) {
		this.#storage = state.storage;
	}

	fetch(): Promise<Response> {
		const storage = this.#storage;
		return Effect.runPromise(
			Effect.gen(function* () {
				const opened = yield* database(storage);
				yield* applySqliteMigrations(
					opened,
					[{ version: 1, statements: ["CREATE TABLE notes (body TEXT NOT NULL) STRICT"] }],
					{ table: "app_schema" },
				);
				yield* Effect.promise(() => opened.run("INSERT INTO notes (body) VALUES (?)", "kept"));
				const notes = yield* Effect.promise(() => opened.all("SELECT body FROM notes"));
				return Response.json({ notes });
			}),
		);
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return env.STORE.getByName("one").fetch(request);
	},
};
