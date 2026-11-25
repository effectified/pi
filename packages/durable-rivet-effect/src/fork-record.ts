// The durable record that a fork's hygiene ran, and for which fork: a table of this host in the actor's database.

import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import { type DurableError, UnexpectedError } from "@gunta/pi-durable-effect";
import { Effect, Option, type Schema } from "effect";
import type { ForkLink } from "./actor-context.ts";

/** The durable record of the forks an actor's storage went through, in a table of this host under the prefix. */
export interface ForkRecord {
	/** The input the fork `link` was made with, if its hygiene was recorded. */
	readonly find: (link: ForkLink) => Effect.Effect<Option.Option<Option.Option<Schema.Json>>, DurableError>;
	/** Records that the hygiene of the fork `link` ran, at `at`, with the input the fork was made with. */
	readonly mark: (link: ForkLink, input: Option.Option<Schema.Json>, at: number) => Effect.Effect<void, DurableError>;
}

/**
 * The fork record of an actor database. The table is made on first use, so only forks have one; a fork of a fork
 * inherits its source's rows, which is why a row names the fork it is for.
 */
export function record(database: SqliteDatabase, prefix: string): Effect.Effect<ForkRecord, DurableError> {
	return Effect.gen(function* () {
		// The prefix becomes part of a table name: Chord's rule for an identifier, the one Pi's storage applies too.
		yield* attempt(async () => validateSqliteSchemaPrefix(prefix));
		const table = `${prefix}rivet_fork`;
		yield* attempt(() =>
			database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
				source_actor_id TEXT NOT NULL,
				forked_at INTEGER NOT NULL,
				input TEXT,
				hygiene_at INTEGER NOT NULL,
				PRIMARY KEY (source_actor_id, forked_at)
			) STRICT`),
		);
		return {
			find: (link) =>
				Effect.map(
					attempt(() =>
						database.get<{ readonly input: string | null }>(
							`SELECT input FROM ${table} WHERE source_actor_id = ? AND forked_at = ?`,
							link.actorId,
							link.forkedAt,
						),
					),
					(row) =>
						Option.map(Option.fromUndefinedOr(row), ({ input }) =>
							// Only `mark` writes the column, with `JSON.stringify` of a JSON value.
							Option.map(Option.fromNullOr(input), (text) => JSON.parse(text) as Schema.Json),
						),
				),
			mark: (link, input, at) =>
				attempt(() =>
					database.run(
						`INSERT INTO ${table} (source_actor_id, forked_at, input, hygiene_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT (source_actor_id, forked_at) DO NOTHING`,
						link.actorId,
						link.forkedAt,
						Option.getOrNull(Option.map(input, (value) => JSON.stringify(value))),
						at,
					),
				),
		};
	});
}

function attempt<A>(run: () => Promise<A>): Effect.Effect<A, DurableError> {
	return Effect.tryPromise({ try: run, catch: (cause) => new UnexpectedError({ cause }) });
}
