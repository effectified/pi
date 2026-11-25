// An Effect `SqlClient` over a Rivet actor's raw database: Rivet's own transactions under Effect's transaction rules,
// one queue with every other user of the database, and this host's rule for a refusal with a retry hint.

import { Effect, Fiber, FiberSet, type Semaphore, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as Refusal from "./refusal.ts";
import type { RawDatabase } from "./sqlite-database.ts";

/**
 * An Effect `SqlClient` of the SQLite dialect over an actor's raw database (`c.db` of `rivetkit/db`).
 *
 * - **One queue.** A statement holds `queue` (one permit) while Rivet runs it, a transaction from its start to its
 *   end. Everything else that uses the database waits on the same `queue`: the host gives its `SqliteDatabase`
 *   adapter the same one. rivetkit 3.1.1 does not queue a statement issued before its transaction began.
 * - **Rivet's transactions.** `withTransaction` runs Rivet's `transaction(callback)`, whose callback waits until the
 *   Effect has ended: it commits when the Effect succeeds, and rolls back when it fails or is interrupted. A nested
 *   `withTransaction` is a savepoint in it. Not `BEGIN` through a statement: rivetkit holds its own transactions and
 *   its state writes back while one is open, and a stop waits for its grace period before rolling it back.
 *   `SqlClient.BeginTransaction` is ignored, since Rivet's transaction is begun by no statement of the client.
 * - **A refusal with a retry hint** (`Refusal.honouringHint`): a statement outside a transaction, and a transaction
 *   that Rivet refused before it called the callback, are asked again after the hint, in their turn of the queue.
 *   A statement inside a transaction never is: its refusal fails the statement, and ends the transaction. Every later
 *   statement of that transaction fails with the same refusal, and it is rolled back even if its Effect goes on and
 *   succeeds, since SQLite does not say whether an error of its storage rolled the transaction back already.
 * - **The wake's fibers.** Every statement runs as a fiber of `work`. Closing that set ends at once a statement that
 *   waits out a hint, and one that comes afterwards; one Rivet is running is waited for. Interrupting the caller
 *   interrupts its statement the same way.
 * - Rows are Rivet's: objects with the columns in order. `values` reads them in that order, so two columns of one
 *   name give one value. A BLOB reads back as an array of numbers. `stream` reads every row first.
 */
export function make(
	raw: RawDatabase,
	queue: Semaphore.Semaphore,
	work: FiberSet.FiberSet,
): Effect.Effect<SqlClient.SqlClient> {
	return Effect.gen(function* () {
		/** One request to Rivet, as a fiber of the wake's work; interrupting the caller interrupts it. */
		const inWake = <A>(request: Effect.Effect<A, SqlError>): Effect.Effect<A, SqlError> =>
			Effect.flatMap(FiberSet.run(work, request), (fiber) =>
				Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber)),
			);
		const outside = connection((sql, params) =>
			inWake(
				Effect.retry(
					attempt(() => raw.execute(sql, ...params)),
					HINTED,
				),
			),
		);

		// The transaction that holds the queue: at most one, since it holds the queue.
		let open: Open | undefined;
		const inside = (sql: string, params: ReadonlyArray<unknown>) =>
			Effect.suspend(() => {
				// Set: a statement reaches this connection only inside its transaction, whose end it cannot outlive.
				const transaction = open as Open;
				if (transaction.refusal !== undefined) return Effect.fail(transaction.refusal);
				return inWake(
					Effect.tapError(
						attempt(() => transaction.handle.execute(sql, ...params)),
						(error) =>
							Effect.sync(() => {
								if (hintOf(error) !== undefined) transaction.refusal = error;
							}),
					),
				);
			});
		const transactionConnection = connection(inside);
		/** A savepoint statement; nothing to do in a transaction a refusal ended, which is rolled back as a whole. */
		const savepoint = (sql: string) =>
			// Set: savepoints are taken and ended inside the transaction.
			Effect.suspend(() => ((open as Open).refusal === undefined ? Effect.asVoid(inside(sql, [])) : Effect.void));

		const client = yield* SqlClient.make({
			driver: "rivet",
			acquirer: Effect.as(
				Effect.acquireRelease(queue.take(1), () => queue.release(1), { interruptible: true }),
				outside,
			),
			borrower: (use) => queue.withPermit(use(outside)),
			compiler: Statement.makeCompilerSqlite(),
			spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
		}).pipe(Effect.provide(Reactivity.layer));

		const withTransaction = SqlClient.makeWithTransaction({
			transactionService: client.transactionService,
			spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
			// Rivet's transaction begins here, in the turn of the queue: what waits for it waits for the connection.
			acquireConnection: (restore) =>
				Effect.gen(function* () {
					yield* Effect.acquireRelease(restore(queue.take(1)), () => queue.release(1));
					// Ends a transaction this scope began and nothing ended: an interrupted or failed start.
					yield* Effect.addFinalizer(() =>
						Effect.suspend(() => {
							const left = open;
							open = undefined;
							return left === undefined ? Effect.void : rolledBack(left);
						}),
					);
					const opening = begin(raw, (opened) => {
						open = opened;
					});
					yield* restore(Effect.retry(opening, HINTED));
					return transactionConnection;
				}),
			begin: () => Effect.void,
			commit: () =>
				Effect.suspend(() => {
					// Set: Effect commits and rolls back only a transaction this client began.
					const transaction = open as Open;
					open = undefined;
					const { refusal } = transaction;
					return refusal === undefined
						? committed(transaction)
						: Effect.andThen(rolledBack(transaction), Effect.fail(refusal));
				}),
			rollback: () =>
				Effect.suspend(() => {
					// Set: as for the commit.
					const transaction = open as Open;
					open = undefined;
					return rolledBack(transaction);
				}),
			savepoint: (_, id) => savepoint(`SAVEPOINT effect_sql_${id}`),
			releaseSavepoint: (_, id) => savepoint(`RELEASE SAVEPOINT effect_sql_${id}`),
			rollbackSavepoint: (_, id) => savepoint(`ROLLBACK TO SAVEPOINT effect_sql_${id}`),
		});
		// As `@effect/sql-sqlite-do` does for Durable Objects: the client's own `withTransaction` would send `BEGIN`.
		return Object.assign(client, { withTransaction });
	});
}

/** OpenTelemetry's attribute for the database system, as Effect's SQLite drivers set it. */
const ATTR_DB_SYSTEM_NAME = "db.system.name";

/** A transaction of Rivet's that the client holds open. */
interface Open {
	/** Rivet's handle of the transaction: statements of the transaction run on it. */
	readonly handle: RawDatabase;
	/** Ends Rivet's callback: commit, or roll back. */
	readonly finish: (commit: boolean) => void;
	/** Settles once Rivet has committed (resolves) or rolled back (rejects). */
	readonly done: Promise<unknown>;
	/** The refusal a statement of the transaction met: the transaction can only roll back. */
	refusal: SqlError | undefined;
}

/**
 * Begins one of Rivet's transactions: once Rivet calls the callback, `opened` is given the transaction, in that call,
 * and the Effect succeeds; the callback then waits until `finish`. Fails when Rivet rejects before it called the
 * callback, so nothing of it ran. Interrupted before Rivet called the callback, the transaction rolls back as soon as
 * it is called, and the interruption waits for that; called already, it is `opened`'s to end.
 */
function begin(raw: RawDatabase, opened: (transaction: Open) => void): Effect.Effect<void, SqlError> {
	return Effect.callback<void, SqlError>((resume) => {
		const finished = Promise.withResolvers<boolean>();
		let called = false;
		let abandoned = false;
		const done = raw.transaction(async (handle) => {
			called = true;
			if (abandoned) throw ROLLED_BACK;
			// Given in this call, not through the fiber: an interruption cannot come between Rivet and its owner.
			opened({ handle, finish: finished.resolve, done, refusal: undefined });
			resume(Effect.void);
			if (!(await finished.promise)) throw ROLLED_BACK;
		}, TRANSACTION);
		done.catch((cause: unknown) => {
			if (!called) resume(Effect.fail(sqlError(cause, "transaction")));
		});
		return Effect.suspend(() => {
			abandoned = true;
			return called ? Effect.void : Effect.promise(() => done.then(ignored, ignored));
		});
	});
}

const ignored = (): void => undefined;

/** The callback's own failure that makes Rivet roll back: never seen outside this module. */
const ROLLED_BACK = new Error("rolled back by its Effect");

// Rivet groups a transaction's profile by a static name, and warns about one without.
const TRANSACTION = { name: "actor-sql" };

/** Lets Rivet commit the transaction, and waits for it: a commit Rivet rejects fails, and Rivet has rolled back. */
function committed(transaction: Open): Effect.Effect<void, SqlError> {
	return Effect.asVoid(
		Effect.tryPromise({
			try: () => {
				transaction.finish(true);
				return transaction.done;
			},
			catch: (cause) => sqlError(cause, "commit"),
		}),
	);
}

/** Lets Rivet roll the transaction back, and waits for it. Nothing of the transaction is kept, whatever Rivet answers. */
function rolledBack(transaction: Open): Effect.Effect<void> {
	return Effect.promise(() => {
		transaction.finish(false);
		return transaction.done.then(ignored, ignored);
	});
}

/** A connection whose every statement goes to `run`, with the rows as Rivet gives them. */
function connection(
	run: (
		sql: string,
		params: ReadonlyArray<unknown>,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
): Connection {
	const rows: Connection["execute"] = (sql, params, transform) =>
		transform === undefined ? run(sql, params) : Effect.map(run(sql, params), transform);
	const values = (sql: string, params: ReadonlyArray<unknown>) =>
		Effect.map(run(sql, params), (found) => found.map((row) => Object.values(row)));
	return {
		execute: rows,
		executeRaw: run,
		executeStream: (sql, params, transform) => Stream.fromIterableEffect(rows(sql, params, transform)),
		executeValues: values,
		executeValuesUnprepared: values,
		// Rivet prepares nothing a caller can keep: every statement is sent as text.
		executeUnprepared: rows,
	};
}

/** One request to Rivet. Uninterruptible: an interrupted request waits for Rivet's answer before it ends. */
function attempt(request: () => Promise<ReadonlyArray<Record<string, unknown>>>) {
	return Effect.uninterruptible(Effect.tryPromise({ try: request, catch: (cause) => sqlError(cause, "execute") }));
}

function sqlError(cause: unknown, operation: string): SqlError {
	return new SqlError({ reason: classifySqliteError(cause, { operation }) });
}

/** The retry hint of a refusal, read off Rivet's error under the `SqlError`. */
function hintOf(error: SqlError): number | undefined {
	return Refusal.retryAfterMillis(error.reason.cause);
}

const HINTED = Refusal.honouringHint(hintOf);
