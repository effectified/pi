// The durable record that a fork's hygiene ran, and for which fork: a table of this host in the actor's database.

import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import { type DurableError, UnexpectedError } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { ForkLink } from "./actor-context.ts";

/** The durable record of the forks an actor's storage went through, in a table of this host under the prefix. */
export interface ForkRecord {
	/** The input the fork `link` was made with, if its hygiene was recorded. */
	readonly find: (link: ForkLink) => Effect.Effect<Option.Option<Option.Option<Schema.Json>>, DurableError>;
	/** Records that the hygiene of the fork `link` ran, at `at`, with the input the fork was made with. */
	readonly mark: (link: ForkLink, input: Option.Option<Schema.Json>, at: number) => Effect.Effect<void, DurableError>;
}

/**
 * The fork record of an actor database, on its `SqlClient`. The table is made on first use, so only forks have one; a
 * fork of a fork inherits its source's rows, which is why a row names the fork it is for. A row whose `input` is no
 * JSON fails `find` with an `UnexpectedError`.
 */
export function record(sql: SqlClient.SqlClient, prefix: string): Effect.Effect<ForkRecord, DurableError> {
	return Effect.gen(function* () {
		// The prefix becomes part of a table name: Chord's rule for an identifier, the one Pi's storage applies too.
		yield* Effect.try({ try: () => validateSqliteSchemaPrefix(prefix), catch: unexpected });
		const table = sql(`${prefix}rivet_fork`);
		yield* Effect.mapError(
			sql`CREATE TABLE IF NOT EXISTS ${table} (
				source_actor_id TEXT NOT NULL,
				forked_at INTEGER NOT NULL,
				input TEXT,
				hygiene_at INTEGER NOT NULL,
				PRIMARY KEY (source_actor_id, forked_at)
			) STRICT`,
			unexpected,
		);
		const find = SqlSchema.findOneOption({
			Request: Link,
			Result: Stored,
			execute: (link) =>
				sql`SELECT input FROM ${table} WHERE source_actor_id = ${link.actorId} AND forked_at = ${link.forkedAt}`,
		});
		return {
			find: (link) =>
				Effect.mapError(
					Effect.flatMap(
						find(link),
						Option.match({
							onNone: () => Effect.succeedNone,
							onSome: (stored) => Effect.asSome(decodeInput(stored.input)),
						}),
					),
					unexpected,
				),
			mark: (link, input, at) =>
				Effect.mapError(
					Effect.flatMap(encodeInput(input), (text) => {
						const row = { source_actor_id: link.actorId, forked_at: link.forkedAt, input: text, hygiene_at: at };
						return sql`INSERT INTO ${table} ${sql.insert(row)} ON CONFLICT (source_actor_id, forked_at) DO NOTHING`;
					}),
					unexpected,
				),
		};
	});
}

/** A fork, as the record is asked about it. */
const Link = Schema.Struct({ actorId: Schema.String, forkedAt: Schema.Number });

/** The `input` column as SQLite gives it: NULL for a fork made without an input, else JSON text. */
const Stored = Schema.Struct({ input: Schema.NullOr(Schema.String) });

/**
 * The input a stored column holds. A decode boundary: the column is read back from the database, where anything could
 * have written it. NULL is told apart before the JSON is decoded, since JSON has a `null` of its own: a fork made with
 * the input `null` keeps it.
 */
function decodeInput(column: string | null): Effect.Effect<Option.Option<Schema.Json>, Schema.SchemaError> {
	return column === null ? Effect.succeedNone : Effect.asSome(decodeJsonText(column));
}

/** The input as the `input` column holds it. */
function encodeInput(input: Option.Option<Schema.Json>): Effect.Effect<string | null, Schema.SchemaError> {
	return Option.match(input, { onNone: () => Effect.succeed(null), onSome: encodeJsonText });
}

const JsonText = Schema.fromJsonString(Schema.Json);

const decodeJsonText = Schema.decodeEffect(JsonText);

const encodeJsonText = Schema.encodeEffect(JsonText);

function unexpected(cause: unknown): UnexpectedError {
	return new UnexpectedError({ cause });
}
