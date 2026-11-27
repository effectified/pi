// Chord's `SqliteDatabase` over an Effect `SqlClient`, so Pi's SQLite storage runs on any Effect SQLite driver.

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@effectified/pi-chord/sqlite";
import { Array as Arr, Cause, type Context, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The `SqliteDatabase` Pi's `SqliteStorage` opens, over the `SqlClient` of the context (SQLite dialect).
 *
 * - A transaction is the client's `withTransaction`, so it shares the connection and the queue with the rest of the
 *   program's SQL: statements of others wait until it finishes, and its handle fails once it has ended.
 * - `exec` runs one statement, which is all Pi's storage and migrations pass it: `SqlClient` has no call for several.
 * - `close` closes nothing: the client belongs to the Layer that provides it.
 */
export const make: Effect.Effect<SqliteDatabase, never, SqlClient> = Effect.gen(function* () {
	// Pi's names are the stored names: a client configured to rename columns must not rename these.
	const client = yield* SqlClient;
	const sql = client.withoutTransforms();
	const services = yield* Effect.context<never>();
	const run = runner(services);
	const transaction = <T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> =>
		run(
			sql.withTransaction(
				Effect.flatMap(Effect.context<never>(), (inTransaction) =>
					// The context inside `withTransaction` carries its connection: statements run with it join the transaction.
					Effect.promise(() => callback(executor(sql, runner(inTransaction)))),
				),
			),
		);
	return {
		...executor(sql, run),
		// The statement and its count must not be separated by another caller's statement.
		runCounted: (text, ...params) => transaction((handle) => handle.runCounted(text, ...params)),
		transaction,
		close: () => Promise.resolve(),
	};
});

/** Runs an Effect of SQL statements as the promise Chord expects, rejecting as its `SqliteDatabase` contract says. */
type Run = <A>(effect: Effect.Effect<A, SqlError>) => Promise<A>;

function runner(context: Context.Context<never>): Run {
	const runExit = Effect.runPromiseExitWith(context);
	return (effect) =>
		runExit(effect).then((exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(rejection(exit.cause))));
}

/**
 * What a failed statement or transaction rejects with: the statement's error or the callback's own error, unchanged.
 * A transaction that also failed to roll back has two reasons and rejects with another error, so its caller cannot
 * take the callback's error for a guaranteed rollback.
 */
function rejection(cause: Cause.Cause<SqlError>): unknown {
	if (cause.reasons.length === 1) return Cause.squash(cause);
	return new AggregateError(
		Arr.map(cause.reasons, (reason) => Cause.squash(Cause.fromReasons([reason]))),
		"SQLite transaction failed and rollback failed",
	);
}

/**
 * Chord's statements on `sql`, each one Effect run as a promise. The rows are Pi's own to decode: Chord's contract is
 * typed by the caller (`get<T>`, `all<T>`), and Pi parses the JSON records it stores itself.
 */
function executor(sql: SqlClient, run: Run): SqliteExecutor {
	return {
		exec: (text) => run(Effect.asVoid(sql.unsafe(text).unprepared)),
		run: (text, ...params) => run(Effect.asVoid(sql.unsafe(text, params))),
		runCounted: (text, ...params) =>
			run(
				Effect.andThen(
					sql.unsafe(text, params),
					Effect.map(sql.unsafe<{ readonly changes: number }>("SELECT changes() AS changes"), (counted) =>
						Number(Option.getOrUndefined(Arr.head(counted))?.changes),
					),
				),
			),
		get: <T extends object>(text: string, ...params: SqliteValue[]) =>
			run(Effect.map(sql.unsafe<T>(text, params), (rows) => Option.getOrUndefined(Arr.head(rows)))),
		// A decode boundary: Effect types the rows read-only, and this array is the driver's own, handed to one caller.
		all: <T extends object>(text: string, ...params: SqliteValue[]) =>
			run(sql.unsafe<T>(text, params)) as Promise<T[]>,
	};
}
