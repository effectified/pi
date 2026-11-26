// Chord's `SqliteDatabase` over a Rivet actor's raw database, so Pi's SQLite storage runs on the actor's SQLite.

import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@effectified/pi-chord/sqlite";
import { Effect, Semaphore } from "effect";
import * as Refusal from "./refusal.ts";

/**
 * What this adapter uses of the raw database of `rivetkit/db` (`c.db` of an actor defined with `db: db()`), typed
 * structurally: `execute` runs SQL text with positional bindings and resolves with the rows, and without bindings
 * may hold several statements; `transaction` runs a callback on a transaction handle.
 */
export interface RawDatabase {
	execute(query: string, ...args: unknown[]): Promise<Record<string, unknown>[]>;
	transaction<T>(
		callback: (transaction: RawDatabase) => Promise<T> | T,
		options?: { readonly name?: string },
	): Promise<T>;
}

/**
 * How the adapter runs each of its operations, and settles its promise: the run function of a `FiberSet`
 * (`FiberSet.makeRuntimePromise`), so the operations are fibers of the set and see the services of the context the
 * function was made in, such as its `Clock`; or `Effect.runPromise`, a fiber of its own that nothing interrupts.
 */
export type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/**
 * The `SqliteDatabase` Pi's `SqliteStorage` opens, over an actor's raw database. Each operation runs with `run`.
 *
 * - **A queue.** Every operation waits for the ones asked for before it, and a transaction holds the queue until it
 *   has ended, as Chord's contract says. rivetkit 3.1.1 isolates a transaction (a statement outside neither joins it
 *   nor sees what it has not committed) but does not queue a statement issued before the transaction began. `queue`
 *   (one permit) is the queue: give everything else that uses the database the same one, as the host gives its
 *   `ActorSql`. By default the adapter has a queue of its own.
 * - A transaction is Rivet's own: it commits when the callback resolves, rolls back and rejects with the callback's
 *   own error when it rejects, and fails a handle used afterwards. One gap: Rivet hides a failed rollback, so the
 *   callback's error is all a caller sees then.
 * - `runCounted` on the database runs in a transaction of its own, so nothing else that uses the actor's database
 *   comes between the statement and its count.
 * - `close` closes nothing: the actor owns the database and closes it when it stops.
 * - A BLOB column reads back as Rivet gives it, an array of numbers. Pi's storage stores none.
 * - **A refusal with a retry hint is asked again** (`Refusal.honouringHint`) where a second run is safe. Rivet's
 *   storage refuses a request before running it while a volume changes hands, and nothing of a refused request was
 *   applied. Asked again: a statement on the database, in its turn of the queue; `runCounted` on the database, as a
 *   whole, since Rivet rolled its transaction back; and a transaction that was refused before its callback was called.
 *   Never asked again: a statement inside a transaction, and a transaction whose callback has run, because the
 *   callback is the caller's code and nothing says it may run twice: that refusal rolls the transaction back and
 *   reaches the caller.
 * - **Interrupting its fibers** (`FiberSet.clear` on the set of `run`, or closing the set's scope) ends at once an
 *   operation that waits for its turn or waits out a hint, and its promise rejects. An operation Rivet is running is
 *   waited for, so the queue never has two at Rivet, and then rejects too: as after a crash, it may have been applied.
 */
export function make(
	raw: RawDatabase,
	run: Run = Effect.runPromise,
	queue: Semaphore.Semaphore = Semaphore.makeUnsafe(1),
): SqliteDatabase {
	const inTurn = <T>(operation: Effect.Effect<T, unknown>): Promise<T> => run(queue.withPermits(1)(operation));
	const asked = <T>(operation: () => Promise<T>) => inTurn(Effect.retry(attempt(operation), HINTED));
	const direct = executor(raw);
	return {
		exec: (sql) => asked(() => direct.exec(sql)),
		run: (sql, ...params) => asked(() => direct.run(sql, ...params)),
		runCounted: (sql, ...params) =>
			asked(() => raw.transaction((transaction) => counted(transaction, sql, params), COUNTED)),
		get: <T extends object>(sql: string, ...params: SqliteValue[]) => asked(() => direct.get<T>(sql, ...params)),
		all: <T extends object>(sql: string, ...params: SqliteValue[]) => asked(() => direct.all<T>(sql, ...params)),
		transaction: (callback) => {
			let called = false;
			const once = (transaction: RawDatabase) => {
				called = true;
				return callback(executor(transaction));
			};
			return inTurn(
				Effect.retry(
					attempt(() => raw.transaction(once, TRANSACTION)),
					{ schedule: HINTED, while: () => !called },
				),
			);
		},
		close: () => Promise.resolve(),
	};
}

/** One request to Rivet. Uninterruptible: an interrupted operation waits for Rivet's answer before it ends. */
function attempt<T>(operation: () => Promise<T>): Effect.Effect<T, unknown> {
	// The caller sees what Rivet rejected with, as Chord's contract has it: the callback's own error, for one.
	return Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: (error) => error }));
}

const HINTED = Refusal.honouringHint(Refusal.retryAfterMillis);

// Rivet groups a transaction's profile by a static name, and warns about one without.
const COUNTED = { name: "pi-durable-counted" };

const TRANSACTION = { name: "pi-durable" };

function executor(raw: RawDatabase): SqliteExecutor {
	// A decode boundary: SQLite gives plain rows, and each caller names the shape of the rows its statement selects.
	const all = <T extends object>(sql: string, params: SqliteValue[]) => raw.execute(sql, ...params) as Promise<T[]>;
	return {
		exec: async (sql) => {
			await raw.execute(sql);
		},
		run: async (sql, ...params) => {
			await raw.execute(sql, ...params);
		},
		runCounted: (sql, ...params) => counted(raw, sql, params),
		get: async <T extends object>(sql: string, ...params: SqliteValue[]) => (await all<T>(sql, params))[0],
		all: <T extends object>(sql: string, ...params: SqliteValue[]) => all<T>(sql, params),
	};
}

/** Runs the statement, then reads SQLite's `changes()`: the caller makes sure nothing runs between the two. */
async function counted(raw: RawDatabase, sql: string, params: SqliteValue[]): Promise<number> {
	await raw.execute(sql, ...params);
	const rows = await raw.execute("SELECT changes() AS changes");
	return Number(rows[0]?.changes);
}
