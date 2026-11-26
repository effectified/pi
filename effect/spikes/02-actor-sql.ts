// Spike for the survey's finding 3: can an Effect `SqlClient` run on a Rivet actor's own SQLite (`c.db` of
// rivetkit 3.1.1)? One bare actor answers each question on its own database, on a local engine of this process:
// manual transaction control through `execute`, a transaction held across awaits and across the actor's actions,
// what a sleep does to an open one, what a refusal with a retry hint leaves behind, and what an interrupted fiber
// leaves behind with Rivet's `transaction(callback)` and with `BEGIN`. It prints one JSON report.
// Run from the repository root (the engine binary of rivetkit's platform package must be installed):
//   node --conditions=source effect/spikes/02-actor-sql.node.ts      bun --conditions=source effect/spikes/02-actor-sql.bun.ts
//
// What it found on 2026-11-26, the same on Node 26.13.1 and Bun 1.4.5 (rivetkit 3.1.1, native SQLite):
// - `execute` takes BEGIN, BEGIN IMMEDIATE, SAVEPOINT, ROLLBACK TO, RELEASE, ROLLBACK and COMMIT. Such a transaction
//   holds across awaits and across actions: another action's statements see its rows and join it. While it is open,
//   rivetkit holds back `db.transaction()` and its state writes ("Waited 1000 ms for a manual SQLite transaction to
//   finish"), and a sleep waits out its grace period, then rolls it back. A second BEGIN fails, inside Rivet's
//   transaction too; a SAVEPOINT inside Rivet's transaction works.
// - Rivet's own transaction makes statements outside it wait until it ends, and expires after 60 s.
// - Interrupted in the middle: Rivet's transaction run as a promise runs its callback to the end and commits; the
//   prototype client on BEGIN and Rivet's transaction under Effect's wrapper both roll back.
// - No refusal with a retry hint came in about 1,000 writes per runtime of every kind while the actor was forked 12
//   times, so what one leaves inside a transaction was not observed.
// - Three statements in a transaction cost about the same on Rivet's transaction, on BEGIN IMMEDIATE and under
//   Effect's wrapper (within the run-to-run noise of a loaded machine).
// The host's `ActorSql` (packages/durable-rivet-effect/src/actor-sql.ts) drives Rivet's transaction with Effect's.

import { Client, type EngineUnavailable } from "@effectified/pi-durable-rivet";
import type * as LocalEngine from "@effectified/pi-durable-rivet/node";
import * as Testing from "@effectified/pi-durable-rivet/testing";
import { Context, Deferred, Duration, Effect, Exit, Fiber, Schedule, type Scope, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import { type ActorContext, actor } from "rivetkit";
import type { ClientRaw } from "rivetkit/client";
import { type DatabaseProvider, db, type RawAccess } from "rivetkit/db";

/** What the spike needs of a local engine entry: `serve` of `/node` or `/bun`. */
export type Serve = (
	options: LocalEngine.ServeOptions,
) => Effect.Effect<{ readonly endpoint: string }, EngineUnavailable, Scope.Scope>;

type Cell = ActorContext<unknown, unknown, unknown, unknown, unknown, DatabaseProvider<RawAccess>>;

/** What a step answered: its value, or the message, the name and the retry hint of what it threw. */
type Outcome = { readonly ok: unknown } | { readonly error: string; readonly hint?: number };

async function outcome(step: () => Promise<unknown>): Promise<Outcome> {
	try {
		return { ok: await step() };
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		const metadata = (error as { metadata?: { retry_after_ms?: number } } | undefined)?.metadata;
		return metadata?.retry_after_ms === undefined
			? { error: message }
			: { error: message, hint: metadata.retry_after_ms };
	}
}

const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

const count = async (raw: RawAccess, where = "1 = 1"): Promise<number> =>
	Number((await raw.execute(`SELECT count(*) AS n FROM t WHERE ${where}`))[0]?.n);

const fresh = (raw: RawAccess) => raw.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, tag TEXT)");

// What the actors of this process did around a sleep, by actor id: the test and the actors share the process.
const lifecycle = new Map<string, string[]>();

// What the churn loop met, by actor id.
const churned = new Map<string, unknown[]>();

/** The prototype client over the raw database: Effect's SQLite acquirers, transactions with `BEGIN IMMEDIATE`. */
function acquirersClient(raw: RawAccess): Effect.Effect<SqlClient.SqlClient> {
	return Effect.gen(function* () {
		const connection = rawConnection(raw);
		const acquirers = SqlClient.makeSqliteAcquirers({
			connection: Effect.succeed(connection),
			semaphore: yield* Semaphore.make(1),
		});
		return yield* SqlClient.make({
			driver: "rivet-spike",
			acquirer: acquirers.acquirer,
			borrower: acquirers.borrower,
			transactionAcquirer: acquirers.transactionAcquirer,
			onCommitFailure: acquirers.onCommitFailure,
			compiler: Statement.makeCompilerSqlite(),
			spanAttributes: [],
			beginTransaction: "BEGIN IMMEDIATE",
			releaseSavepoint: (name: string) => `RELEASE SAVEPOINT ${name}`,
		});
	}).pipe(Effect.provide(Reactivity.layer));
}

function rawConnection(raw: RawAccess): Connection {
	const run = (sql: string, params: ReadonlyArray<unknown>) =>
		Effect.tryPromise({
			try: () => raw.execute(sql, ...params),
			catch: (cause) => new SqlError({ reason: classifySqliteError(cause, { operation: "execute" }) }),
		});
	const values = (sql: string, params: ReadonlyArray<unknown>) =>
		Effect.map(run(sql, params), (rows) => rows.map((row) => Object.values(row)));
	return {
		execute: (sql, params, transform) => (transform ? Effect.map(run(sql, params), transform) : run(sql, params)),
		executeRaw: run,
		executeStream: (sql, params) => Stream.fromIterableEffect(run(sql, params)),
		executeValues: values,
		executeValuesUnprepared: values,
		executeUnprepared: (sql, params, transform) =>
			transform ? Effect.map(run(sql, params), transform) : run(sql, params),
	};
}

/**
 * Rivet's `transaction(callback)` driven by Effect's transaction wrapper, as `@effect/sql-sqlite-do` drives Durable
 * Objects' storage transaction: the callback hands its handle to the fiber and waits until the fiber ends it.
 * Statements of the body run on the handle. Returns the wrapper and a statement runner for the body.
 */
function bridged(raw: RawAccess) {
	const Transaction = SqlClient.TransactionConnection(9_999);
	let open: { readonly handle: RawAccess; readonly end: (commit: boolean) => Promise<void> } | undefined;
	const failed = (cause: unknown) =>
		new SqlError({ reason: classifySqliteError(cause, { operation: "transaction" }) });
	const withTransaction = SqlClient.makeWithTransaction({
		transactionService: Transaction,
		spanAttributes: [],
		acquireConnection: () => Effect.succeed(rawConnection(raw)),
		begin: () =>
			Effect.callback<void, SqlError>((resume) => {
				const ended = Promise.withResolvers<boolean>();
				const done = raw.transaction(async (handle) => {
					open = {
						handle,
						end: async (commit) => {
							ended.resolve(commit);
							await done.catch(() => undefined);
						},
					};
					resume(Effect.void);
					if (!(await ended.promise)) throw new Error("rolled back by the fiber");
				});
				done.catch((cause) => resume(Effect.fail(failed(cause))));
			}),
		savepoint: () => Effect.die("no savepoints in the spike"),
		commit: () => Effect.promise(() => open?.end(true) ?? Promise.resolve()),
		rollback: () => Effect.promise(() => open?.end(false) ?? Promise.resolve()),
		rollbackSavepoint: () => Effect.die("no savepoints in the spike"),
	});
	const execute = (sql: string, ...params: unknown[]) =>
		Effect.tryPromise({ try: () => (open?.handle ?? raw).execute(sql, ...params), catch: failed });
	return { withTransaction, execute };
}

/** A bare Rivet actor whose actions each answer one question on its own database. */
export const Spiked = {
	name: "spiked",
	actions: {},
	rivet: actor({
		db: db({ warnOnManualTransactions: false }),
		options: { actionTimeout: 120_000, sleepTimeout: 60_000 },
		onWake: (c: Cell) => void lifecycle.set(c.actorId, [...(lifecycle.get(c.actorId) ?? []), "wake"]),
		onSleep: (c: Cell) => void lifecycle.set(c.actorId, [...(lifecycle.get(c.actorId) ?? []), "sleep"]),
		actions: {
			/** Manual transaction control through `execute`, in one action. */
			manual: async (c: Cell) => {
				const raw = c.db;
				await fresh(raw);
				const r: Record<string, unknown> = {};
				r.begin = await outcome(() => raw.execute("BEGIN"));
				await raw.execute("INSERT INTO t (id, tag) VALUES (1, 'a')");
				await pause(50);
				r.seenAfterAwait = await count(raw);
				r.savepoint = await outcome(() => raw.execute("SAVEPOINT s1"));
				await raw.execute("INSERT INTO t (id, tag) VALUES (2, 'b')");
				r.rollbackTo = await outcome(() => raw.execute("ROLLBACK TO SAVEPOINT s1"));
				r.release = await outcome(() => raw.execute("RELEASE SAVEPOINT s1"));
				r.afterSavepointRollback = await count(raw);
				r.nestedBegin = await outcome(() => raw.execute("BEGIN"));
				r.rivetTransactionInsideManual = await timed(() =>
					raw.transaction(async (tx) => (await tx.execute("SELECT count(*) AS n FROM t"))[0]?.n, {
						timeout: 1_000,
					}),
				);
				r.rollback = await outcome(() => raw.execute("ROLLBACK"));
				r.afterRollback = await count(raw);
				r.beginImmediate = await outcome(() => raw.execute("BEGIN IMMEDIATE"));
				await raw.execute("INSERT INTO t (id, tag) VALUES (3, 'c')");
				r.commit = await outcome(() => raw.execute("COMMIT"));
				r.afterCommit = await count(raw);
				r.savepointAsTransaction = await outcome(async () => {
					await raw.execute("SAVEPOINT outer_sp");
					await raw.execute("INSERT INTO t (id, tag) VALUES (4, 'd')");
					await raw.execute("RELEASE SAVEPOINT outer_sp");
					return count(raw);
				});
				r.beginInsideRivetTransaction = await outcome(() => raw.transaction((tx) => tx.execute("BEGIN")));
				r.savepointInsideRivetTransaction = await outcome(() =>
					raw.transaction(async (tx) => {
						await tx.execute("SAVEPOINT inner_sp");
						await tx.execute("INSERT INTO t (id, tag) VALUES (5, 'e')");
						await tx.execute("ROLLBACK TO SAVEPOINT inner_sp");
						await tx.execute("RELEASE SAVEPOINT inner_sp");
						return (await tx.execute("SELECT count(*) AS n FROM t"))[0]?.n;
					}),
				);
				r.lastInsertRowidIntercepted = await outcome(async () => {
					await raw.execute("INSERT INTO t (tag) VALUES ('f')");
					const [intercepted] = await raw.execute("SELECT last_insert_rowid() AS id");
					const [real] = await raw.execute("SELECT max(id) AS id FROM t");
					return { intercepted: intercepted?.id, real: real?.id };
				});
				return r;
			},
			/** Opens a transaction with `BEGIN` and leaves it open when the action returns. */
			openAcross: async (c: Cell) => {
				await fresh(c.db);
				await c.db.execute("BEGIN IMMEDIATE");
				await c.db.execute("INSERT INTO t (id, tag) VALUES (10, 'open')");
				return count(c.db, "id = 10");
			},
			/** Another action while that transaction is open: does it see the row, and can it end the transaction? */
			peekAcross: async (c: Cell) => ({
				seen: await count(c.db, "id = 10"),
				rivetTransaction: await timed(() =>
					c.db.transaction((tx) => tx.execute("SELECT 1 AS one"), { timeout: 1_000 }),
				),
				secondBegin: await outcome(() => c.db.execute("BEGIN")),
			}),
			insertAcross: async (c: Cell) => outcome(() => c.db.execute("INSERT INTO t (id, tag) VALUES (11, 'other')")),
			rollbackAcross: async (c: Cell) => ({
				rollback: await outcome(() => c.db.execute("ROLLBACK")),
				left: await count(c.db, "id IN (10, 11)"),
			}),
			commitAcross: async (c: Cell) => outcome(() => c.db.execute("COMMIT")),
			count: async (c: Cell) => outcome(() => count(c.db, "id >= 10")),
			nap: (c: Cell) => {
				c.sleep();
				return null;
			},
			/** Rivet's transaction left open across actions: its callback waits for a later action. */
			rivetOpenAcross: async (c: Cell) => {
				await fresh(c.db);
				const gate = Promise.withResolvers<void>();
				rivetGates.set(c.actorId, gate);
				const done = c.db.transaction(async (tx) => {
					await tx.execute("INSERT INTO t (id, tag) VALUES (20, 'rivet-open')");
					await gate.promise;
				});
				rivetDone.set(
					c.actorId,
					outcome(() => done),
				);
				await pause(50);
				// Outside the transaction, while its callback waits: do these wait for it, or run beside it?
				const settled: string[] = [];
				const read = outcome(() => count(c.db, "id = 20")).then((seen) => {
					settled.push("read");
					return seen;
				});
				const write = outcome(() => c.db.execute("INSERT INTO t (id, tag) VALUES (21, 'outside')")).then(
					(wrote) => {
						settled.push("write");
						return wrote;
					},
				);
				rivetOutside.set(c.actorId, Promise.all([read, write]));
				await pause(300);
				return { settledWhileOpen: [...settled] };
			},
			rivetCloseAcross: async (c: Cell) => {
				rivetGates.get(c.actorId)?.resolve();
				const [read, write] = (await rivetOutside.get(c.actorId)) ?? [];
				return {
					transaction: await rivetDone.get(c.actorId),
					outsideRead: read,
					outsideWrite: write,
					rows: await count(c.db, "id IN (20, 21)"),
				};
			},
			/** Interruption of a fiber in the middle of a transaction, three ways. */
			interrupt: async (c: Cell) => {
				await fresh(c.db);
				return Effect.runPromise(interruptions(c.db));
			},
			/** The prototype client's statements, transactions, savepoints and failures. */
			client: async (c: Cell) => {
				await fresh(c.db);
				return Effect.runPromise(clientChecks(c.db));
			},
			/** Timing: statements and transactions through the raw database, the prototype client and the bridge. */
			timing: async (c: Cell) => {
				await fresh(c.db);
				return Effect.runPromise(timing(c.db));
			},
			/** Writes for `millis` in the background, in every mode, and records whatever it meets. */
			churn: (c: Cell, millis: number) => {
				const seen: unknown[] = [];
				churned.set(c.actorId, seen);
				c.keepAwake(churn(c.db, millis, seen));
				return null;
			},
			churned: (c: Cell) => churned.get(c.actorId) ?? [],
		},
	}),
};

const rivetGates = new Map<string, PromiseWithResolvers<void>>();
const rivetDone = new Map<string, Promise<Outcome>>();
const rivetOutside = new Map<string, Promise<[Outcome, Outcome]>>();

/** `outcome`, with how long it took. */
async function timed(step: () => Promise<unknown>): Promise<Outcome & { readonly millis: number }> {
	const start = Date.now();
	const answered = await outcome(step);
	return { ...answered, millis: Date.now() - start };
}

function interruptions(raw: RawAccess) {
	return Effect.gen(function* () {
		const r: Record<string, unknown> = {};

		// 1. Rivet's transaction(callback) as an Effect today: a promise that nothing stops.
		const gate = Promise.withResolvers<void>();
		const started = yield* Deferred.make<void>();
		let callbackEnded = false;
		const running = Promise.withResolvers<unknown>();
		const fiber = yield* Effect.forkChild(
			Effect.tryPromise(() => {
				const done = raw.transaction(async (tx) => {
					await tx.execute("INSERT INTO t (id, tag) VALUES (30, 'rivet')");
					Deferred.doneUnsafe(started, Exit.void);
					await gate.promise;
					await tx.execute("INSERT INTO t (id, tag) VALUES (31, 'rivet')");
					callbackEnded = true;
				});
				done.then(running.resolve, running.resolve);
				return done;
			}),
		);
		yield* Deferred.await(started);
		yield* Fiber.interrupt(fiber);
		r.rivetFiberInterrupted = true;
		gate.resolve();
		yield* Effect.promise(() => running.promise);
		r.rivetCallbackRanToTheEnd = callbackEnded;
		r.rivetRowsAfterInterrupt = yield* Effect.promise(() => count(raw, "id IN (30, 31)"));

		// 2. The prototype client: `withTransaction` on BEGIN, interrupted after its first statement.
		const sql = yield* acquirersClient(raw);
		const inserted = yield* Deferred.make<void>();
		const body = Effect.gen(function* () {
			yield* sql`INSERT INTO t (id, tag) VALUES (40, 'manual')`;
			yield* Deferred.succeed(inserted, undefined);
			return yield* Effect.never;
		});
		const manual = yield* Effect.forkChild(sql.withTransaction(body));
		yield* Deferred.await(inserted);
		yield* Fiber.interrupt(manual);
		r.manualRowsAfterInterrupt = yield* Effect.promise(() => count(raw, "id = 40"));
		r.manualNextTransaction = yield* Effect.exit(
			sql.withTransaction(sql`INSERT INTO t (id, tag) VALUES (41, 'next')`),
		).pipe(Effect.map(Exit.isSuccess));
		r.manualNoTransactionLeftOpen = yield* Effect.promise(() => outcome(() => raw.execute("BEGIN")));
		yield* Effect.promise(() => raw.execute("ROLLBACK"));

		// 3. Rivet's transaction(callback) bridged by Effect's wrapper, interrupted after its first statement.
		const bridge = bridged(raw);
		const insertedBridged = yield* Deferred.make<void>();
		const bridgedFiber = yield* Effect.forkChild(
			bridge.withTransaction(
				Effect.gen(function* () {
					yield* bridge.execute("INSERT INTO t (id, tag) VALUES (50, 'bridged')");
					yield* Deferred.succeed(insertedBridged, undefined);
					return yield* Effect.never;
				}),
			),
		);
		yield* Deferred.await(insertedBridged);
		yield* Fiber.interrupt(bridgedFiber);
		r.bridgedRowsAfterInterrupt = yield* Effect.promise(() => count(raw, "id = 50"));
		return r;
	});
}

function clientChecks(raw: RawAccess) {
	return Effect.gen(function* () {
		const sql = yield* acquirersClient(raw);
		const r: Record<string, unknown> = {};
		yield* sql`INSERT INTO t ${sql.insert({ id: 60, tag: "client" })}`;
		r.read = yield* sql<{ id: number; tag: string }>`SELECT id, tag FROM t WHERE id = ${60}`;
		r.nested = yield* Effect.exit(
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO t (id, tag) VALUES (61, 'outer')`;
					yield* Effect.exit(
						sql.withTransaction(
							Effect.andThen(sql`INSERT INTO t (id, tag) VALUES (62, 'inner')`, Effect.fail("inner failed")),
						),
					);
					return yield* sql<{ n: number }>`SELECT count(*) AS n FROM t WHERE id IN (61, 62)`;
				}),
			),
		).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : String(exit.cause))));
		r.failedStatementInTransaction = yield* Effect.exit(
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO t (id, tag) VALUES (63, 'kept?')`;
					yield* sql`INSERT INTO missing_table (id) VALUES (1)`;
				}),
			),
		).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? "committed" : "failed")));
		r.afterFailedStatement = yield* Effect.promise(() => count(raw, "id = 63"));
		// Concurrent statements and transactions: does the semaphore keep a statement out of an open transaction?
		const order: string[] = [];
		const held = yield* Deferred.make<void>();
		const inTransaction = yield* Effect.forkChild(
			sql.withTransaction(
				Effect.gen(function* () {
					yield* sql`INSERT INTO t (id, tag) VALUES (64, 'tx')`;
					order.push("transaction wrote");
					yield* Deferred.await(held);
					order.push("transaction ends");
				}),
			),
			{ startImmediately: true },
		);
		const outside = yield* Effect.forkChild(
			Effect.tap(sql`INSERT INTO t (id, tag) VALUES (65, 'outside')`, () =>
				Effect.sync(() => order.push("outside wrote")),
			),
			{ startImmediately: true },
		);
		yield* Effect.sleep("50 millis");
		order.push("released");
		yield* Deferred.succeed(held, undefined);
		yield* Fiber.join(inTransaction);
		yield* Fiber.join(outside);
		r.order = order;
		return r;
	});
}

function timing(raw: RawAccess) {
	return Effect.gen(function* () {
		const sql = yield* acquirersClient(raw);
		const bridge = bridged(raw);
		const N = 200;
		const time = <E>(label: string, effect: Effect.Effect<unknown, E>) =>
			Effect.map(Effect.timed(effect), ([duration]) => [label, Math.round(Duration.toMillis(duration))] as const);
		const results = [
			yield* time(
				"raw statements",
				Effect.promise(async () => {
					for (let i = 0; i < N; i++) await raw.execute("INSERT INTO t (tag) VALUES (?)", "raw");
				}),
			),
			yield* time(
				"client statements",
				Effect.forEach(Array.from({ length: N }), () => sql`INSERT INTO t (tag) VALUES (${"client"})`, {
					discard: true,
				}),
			),
			yield* time(
				"raw transactions (Rivet's), 3 statements each",
				Effect.promise(async () => {
					for (let i = 0; i < N; i++)
						await raw.transaction(async (tx) => {
							for (let s = 0; s < 3; s++) await tx.execute("INSERT INTO t (tag) VALUES (?)", "rivet-tx");
						});
				}),
			),
			yield* time(
				"client transactions (BEGIN IMMEDIATE), 3 statements each",
				Effect.forEach(
					Array.from({ length: N }),
					() =>
						sql.withTransaction(
							Effect.forEach([0, 1, 2], () => sql`INSERT INTO t (tag) VALUES (${"client-tx"})`, {
								discard: true,
							}),
						),
					{ discard: true },
				),
			),
			yield* time(
				"bridged transactions (Rivet's under Effect's wrapper), 3 statements each",
				Effect.forEach(
					Array.from({ length: N }),
					() =>
						bridge.withTransaction(
							Effect.forEach([0, 1, 2], () => bridge.execute("INSERT INTO t (tag) VALUES (?)", "bridged-tx"), {
								discard: true,
							}),
						),
					{ discard: true },
				),
			),
		];
		return Object.fromEntries(results);
	});
}

async function churn(raw: RawAccess, millis: number, seen: unknown[]): Promise<void> {
	await fresh(raw);
	const until = Date.now() + millis;
	let n = 0;
	const modes = ["statement", "manual", "rivet"] as const;
	while (Date.now() < until) {
		n += 1;
		const mode = modes[n % modes.length];
		const tag = `churn-${n}`;
		let step = "first";
		const tried = await outcome(async () => {
			if (mode === "statement") {
				await raw.execute("INSERT INTO t (tag) VALUES (?)", tag);
			} else if (mode === "manual") {
				step = "begin";
				await raw.execute("BEGIN IMMEDIATE");
				step = "first";
				await raw.execute("INSERT INTO t (tag) VALUES (?)", tag);
				await pause(2);
				step = "second";
				await raw.execute("INSERT INTO t (tag) VALUES (?)", tag);
				step = "commit";
				await raw.execute("COMMIT");
			} else {
				await raw.transaction(async (tx) => {
					step = "first";
					await tx.execute("INSERT INTO t (tag) VALUES (?)", tag);
					await pause(2);
					step = "second";
					await tx.execute("INSERT INTO t (tag) VALUES (?)", tag);
					step = "commit";
				});
			}
		});
		if ("error" in tried) {
			// What the failure left: is a transaction still open, and what of this iteration was kept?
			const probe = await outcome(() => raw.execute("SELECT 1 AS one"));
			const rollback = mode === "manual" ? await outcome(() => raw.execute("ROLLBACK")) : undefined;
			const kept = await outcome(() => count(raw, `tag = '${tag}'`));
			seen.push({ n, mode, step, ...tried, probe, rollback, kept });
		}
	}
	seen.push({ iterations: n });
}

/** Runs every question against an engine of `serve`, and prints the answers. */
export function run(runtime: string, serve: Serve): Promise<void> {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const hosted = yield* Testing.hosted(serve, { actors: [Spiked], logging: { level: "warn" } });
				// A failed action is part of the answer: it is recorded, and the next question is asked.
				const call = (handle: Client.Handle, name: string, ...args: unknown[]) =>
					Client.RivetClient.use((client) =>
						Effect.promise(() =>
							outcome(() => client.getForId(handle.definition.name, handle.actorId).action({ name, args })),
						),
					).pipe(Effect.provideContext(hosted.context));
				const actorOf = (key: string) =>
					Client.getOrCreate(Spiked, [key]).pipe(Effect.orDie, Effect.provideContext(hosted.context));
				const report: Record<string, unknown> = { runtime };

				const manual = yield* actorOf("manual");
				report.manual = yield* call(manual, "manual");

				const across = yield* actorOf("across");
				report.across = {
					open: yield* call(across, "openAcross"),
					peek: yield* call(across, "peekAcross"),
					insertFromOtherAction: yield* call(across, "insertAcross"),
					rollback: yield* call(across, "rollbackAcross"),
				};

				const slept = yield* actorOf("sleep-open");
				const sleptOpen = yield* call(slept, "openAcross");
				yield* call(slept, "nap");
				yield* Effect.repeat(
					Effect.sync(() => lifecycle.get(slept.actorId) ?? []),
					{ until: (events) => events.includes("sleep"), schedule: Schedule.spaced("100 millis") },
				);
				report.sleepWithOpenTransaction = {
					open: sleptOpen,
					afterWake: yield* call(slept, "count"),
					lifecycle: lifecycle.get(slept.actorId),
				};

				const rivetOpen = yield* actorOf("rivet-open");
				report.rivetTransactionAcrossActions = {
					open: yield* call(rivetOpen, "rivetOpenAcross"),
					close: yield* call(rivetOpen, "rivetCloseAcross"),
				};

				report.interrupt = yield* call(yield* actorOf("interrupt"), "interrupt");
				report.client = yield* call(yield* actorOf("client"), "client");
				report.timing = yield* call(yield* actorOf("timing"), "timing");

				// Refusals: write in every mode while the actor is forked again and again, then put to sleep.
				const source = yield* actorOf("churn");
				yield* call(source, "churn", 8_000);
				const raw: ClientRaw = Context.get(hosted.context, Client.RivetClient);
				const forks: unknown[] = [];
				for (let i = 0; i < 12; i++) {
					forks.push(
						yield* Effect.promise(() =>
							outcome(() =>
								raw.fork(Spiked.name, source.actorId, { key: [`churn-fork-${i}`] }).then((f) => f.resolve()),
							),
						),
					);
				}
				yield* Effect.sleep("8 seconds");
				report.churn = {
					forks: forks.filter((f) => "error" in (f as object)),
					seen: yield* call(source, "churned"),
				};
				console.log(JSON.stringify(report, null, 2));
			}),
		),
	);
}
