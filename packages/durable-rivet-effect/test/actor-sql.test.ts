// The actor's `SqlClient` without an engine: over the stand-in of raw-stand-in.ts, whose transaction is run as
// Rivet's is (its callback runs to its end, then it commits), and behind a storage that refuses. engine-suite.ts runs
// the same client on a real actor database.

import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { runTest } from "@effectified/pi-ai/testing";
import { Storage } from "@effectified/pi-durable";
import { Clock, Deferred, Effect, Exit, Fiber, FiberSet, Option, Result, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Sql from "../src/actor-sql.ts";
import * as Refusal from "../src/refusal.ts";
import type { RawDatabase } from "../src/sqlite-database.ts";
import * as Database from "../src/sqlite-database.ts";
import { type Refusals, refusal, refusingStorage, sqlOver, standIn } from "./raw-stand-in.ts";

/** A fresh stand-in holding the table of these tests. */
const notes = () =>
	Effect.gen(function* () {
		const fresh = standIn();
		yield* Effect.promise(() => fresh.raw.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)"));
		return fresh;
	});

/** The client over `raw`, on a queue and a set of fibers of the test's scope; `database` is the adapter on its queue. */
const clientOf = (raw: RawDatabase) =>
	Effect.gen(function* () {
		const work = yield* FiberSet.make();
		const queue = yield* Semaphore.make(1);
		const sql = yield* Sql.make(raw, queue, work);
		return { sql, work, database: Database.make(raw, yield* FiberSet.runtimePromise(work)(), queue) };
	});

/** The texts of the notes, in order, read on `raw` itself. */
const texts = (raw: RawDatabase) =>
	Effect.promise(async () => (await raw.execute("SELECT text FROM notes ORDER BY id")).map((row) => String(row.text)));

const insert = (sql: SqlClient.SqlClient, id: number, text: string) =>
	sql`INSERT INTO notes ${sql.insert({ id, text })}`;

const Note = Schema.Struct({ id: Schema.Number, text: Schema.String });

describe("ActorSql's statements", () => {
	it("runs statements with bindings, and its rows decode with SqlSchema", () =>
		runTest(
			Effect.gen(function* () {
				const { sql } = yield* clientOf((yield* notes()).raw);
				yield* insert(sql, 1, "first");
				yield* insert(sql, 2, "second");
				const after = SqlSchema.findAll({
					Request: Schema.Number,
					Result: Note,
					execute: (id) => sql`SELECT id, text FROM notes WHERE id > ${id} ORDER BY id`,
				});
				expect(yield* after(0)).toEqual([
					{ id: 1, text: "first" },
					{ id: 2, text: "second" },
				]);
				// A row of another shape fails as a schema error, not as a wrong value.
				const wrong = SqlSchema.findAll({
					Request: Schema.Number,
					Result: Schema.Struct({ id: Schema.String }),
					execute: (id) => sql`SELECT id FROM notes WHERE id = ${id}`,
				});
				expect((yield* Effect.flip(wrong(1)))._tag).toBe("SchemaError");
			}),
		));
});

describe("ActorSql's transactions", () => {
	it("commits, rolls back with its Effect's own failure, and rolls back a nested one alone", () =>
		runTest(
			Effect.gen(function* () {
				const { raw } = yield* notes();
				const { sql } = yield* clientOf(raw);
				yield* sql.withTransaction(insert(sql, 1, "kept"));
				const failed = yield* Effect.flip(
					sql.withTransaction(Effect.andThen(insert(sql, 2, "dropped"), Effect.fail("the body failed"))),
				);
				expect(failed).toBe("the body failed");
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* insert(sql, 3, "outer");
						yield* Effect.exit(
							sql.withTransaction(Effect.andThen(insert(sql, 4, "inner"), Effect.fail("inner failed"))),
						);
					}),
				);
				expect(yield* texts(raw)).toEqual(["kept", "outer"]);
			}),
		));

	it("rolls back a transaction whose fiber is interrupted, where Rivet's transaction run as a promise commits", () =>
		runTest(
			Effect.gen(function* () {
				const { raw } = yield* notes();
				const { sql } = yield* clientOf(raw);
				const inside = yield* Deferred.make<void>();
				const fiber = yield* Effect.forkChild(
					sql.withTransaction(
						Effect.andThen(
							Effect.andThen(insert(sql, 1, "interrupted"), Deferred.succeed(inside, undefined)),
							Effect.never,
						),
					),
				);
				yield* Deferred.await(inside);
				yield* Fiber.interrupt(fiber);
				expect(yield* texts(raw)).toEqual([]);
				// What the swarm's record did before: the interrupted Effect left the callback running, and it committed.
				const gate = Promise.withResolvers<void>();
				const began = yield* Deferred.make<void>();
				const promised = yield* Effect.forkChild(
					Effect.promise(() =>
						raw.transaction(async (transaction) => {
							await transaction.execute("INSERT INTO notes (id, text) VALUES (2, 'committed')");
							Deferred.doneUnsafe(began, Exit.void);
							await gate.promise;
						}),
					),
				);
				yield* Deferred.await(began);
				yield* Fiber.interrupt(promised);
				gate.resolve();
				yield* Effect.promise(() => raw.execute("SELECT 1"));
				expect(yield* texts(raw)).toEqual(["committed"]);
			}),
		));

	it("rolls back a transaction interrupted before Rivet called its callback, and holds the queue until it has", () =>
		runTest(
			Effect.gen(function* () {
				const { raw } = yield* notes();
				const called = Promise.withResolvers<void>();
				const delayed: RawDatabase = {
					execute: (query, ...args) => raw.execute(query, ...args),
					// Rivet calls the callback once something else let go of the database: here, when the test says so.
					transaction: (callback, options) => called.promise.then(() => raw.transaction(callback, options)),
				};
				const { sql } = yield* clientOf(delayed);
				let ran = false;
				const body = Effect.sync(() => {
					ran = true;
				});
				const fiber = yield* Effect.forkChild(sql.withTransaction(body), { startImmediately: true });
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
				const after = yield* Effect.forkChild(insert(sql, 1, "after"), { startImmediately: true });
				yield* Effect.yieldNow;
				// The interruption waits for Rivet: nothing ran, and the statement behind it still waits its turn.
				expect([interrupting.pollUnsafe(), after.pollUnsafe()]).toEqual([undefined, undefined]);
				called.resolve();
				yield* Fiber.join(interrupting);
				yield* Fiber.join(after);
				expect(ran).toBe(false);
				expect(yield* texts(raw)).toEqual(["after"]);
			}),
		));
});

describe("ActorSql's queue", () => {
	it("is the adapter's queue: neither a statement of the adapter nor one of the client comes into a transaction", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, overlaps } = yield* notes();
				const { sql, database } = yield* clientOf(raw);
				const held = yield* Deferred.make<void>();
				const inside = yield* Deferred.make<void>();
				const transaction = yield* Effect.forkChild(
					sql.withTransaction(
						Effect.andThen(
							Effect.andThen(insert(sql, 1, "transaction"), Deferred.succeed(inside, undefined)),
							Deferred.await(held),
						),
					),
					{ startImmediately: true },
				);
				yield* Deferred.await(inside);
				const order: string[] = [];
				const adapter = database
					.run("INSERT INTO notes (id, text) VALUES (2, 'adapter')")
					.then(() => order.push("adapter"));
				const client = yield* Effect.forkChild(
					Effect.tap(insert(sql, 3, "client"), () => Effect.sync(() => order.push("client"))),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				expect(order).toEqual([]);
				yield* Deferred.succeed(held, undefined);
				yield* Fiber.join(transaction);
				yield* Fiber.join(client);
				yield* Effect.promise(() => adapter);
				expect(order).toEqual(["adapter", "client"]);
				expect(overlaps()).toBe(0);
			}),
		));
});

/** A client over a stand-in behind a refusing storage (`refusingStorage`), and what it was asked. */
const refusingClient = (refuse: Refusals, refused: () => unknown = refusal) =>
	Effect.gen(function* () {
		const { raw } = yield* notes();
		const behind = refusingStorage(raw, refuse, refused);
		const { sql, work } = yield* clientOf(behind.raw);
		return { raw, asked: behind.asked, sql, work };
	});

/** The hint of the refusal under a statement's failure. */
const hintOf = (error: SqlError) => Refusal.retryAfterMillis(error.reason.cause);

/** How an Effect ended once the test clock has moved a minute on. */
const onTheClock = <A, E>(effect: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(Effect.result(effect), { startImmediately: true });
		yield* TestClock.adjust("1 minute");
		return yield* Fiber.join(fiber);
	});

describe("a refusal with a retry hint, met by ActorSql", () => {
	it("asks a statement outside a transaction again after each hint, until it is served once", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, asked, sql } = yield* refusingClient({ statements: 2 });
				const done = yield* onTheClock(Effect.andThen(insert(sql, 1, "kept"), Clock.currentTimeMillis));
				expect(Result.getOrUndefined(done)).toBe(200);
				expect(asked.statements).toBe(3);
				expect(yield* texts(raw)).toEqual(["kept"]);
			}),
		));

	it("begins a transaction again that was refused before its callback was called", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, asked, sql } = yield* refusingClient({ begins: 2 });
				let ran = 0;
				const body = Effect.andThen(
					Effect.sync(() => {
						ran += 1;
					}),
					insert(sql, 1, "once"),
				);
				expect(Result.isSuccess(yield* onTheClock(sql.withTransaction(body)))).toBe(true);
				expect({ ran, transactions: asked.transactions }).toEqual({ ran: 1, transactions: 3 });
				expect(yield* texts(raw)).toEqual(["once"]);
			}),
		));

	it("never asks again inside a transaction: the refusal ends it, even if its Effect goes on and succeeds", () =>
		runTest(
			Effect.gen(function* () {
				const { raw, asked, sql } = yield* refusingClient({ inside: 1 });
				const seen: SqlError[] = [];
				const body = Effect.gen(function* () {
					// The body catches the refusal and goes on: the next statement fails with it too.
					seen.push(yield* Effect.orDie(Effect.flip(insert(sql, 1, "refused"))));
					seen.push(yield* Effect.orDie(Effect.flip(insert(sql, 2, "after the refusal"))));
				});
				const ended = yield* onTheClock(sql.withTransaction(body));
				expect([...seen, ...Option.toArray(Result.getFailure(ended))].map(hintOf)).toEqual([
					Option.some(100),
					Option.some(100),
					Option.some(100),
				]);
				expect({ statements: asked.statements, transactions: asked.transactions }).toEqual({
					statements: 0,
					transactions: 1,
				});
				expect(yield* texts(raw)).toEqual([]);
			}),
		));

	it("ends at once a statement that waits out a hint when the wake's work is closed, and asks nothing again", () =>
		runTest(
			Effect.gen(function* () {
				// A hint of five seconds, and the clock never moves: only the interruption can end the wait.
				const { asked, sql, work } = yield* refusingClient({ statements: 1 }, () => refusal("depot", 5_000));
				const waiting = yield* Effect.forkChild(insert(sql, 1, "refused"), { startImmediately: true });
				yield* Effect.yieldNow;
				expect(asked.statements).toBe(1);
				yield* FiberSet.clear(work);
				const ended = yield* Fiber.await(waiting);
				expect(Exit.hasInterrupts(ended)).toBe(true);
				expect(asked.statements).toBe(1);
				expect(yield* Clock.currentTimeMillis).toBe(0);
			}),
		));
});

registerStorageConformance(
	{ describe, expect, it },
	"Pi's storage conformance on Storage.sql over ActorSql, over the stand-in",
	(use) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* sqlOver(standIn().raw);
					yield* Storage.HarnessStorage.use((opened) => Effect.promise(() => use(opened))).pipe(
						Effect.provide(Storage.sql({ prefix: "pi_" })),
						Effect.provideService(SqlClient.SqlClient, sql),
					);
				}),
			),
		),
);
