// A refusal with a retry hint, with the refusal injected: every place that can meet one asks again a bounded number
// of times, and no place repeats what may have run. The refusal is Rivet's own, as it was caught on a local engine:
// `depot.overloaded` with the reason `volume_transition` and a hint of 100 milliseconds, answered to a fork. The
// hints are waited out on the test clock, so no test waits for the machine.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { runTest } from "@effectified/pi-ai/testing";
import { Clock, Effect, Exit, Fiber, FiberSet, Layer, Option, Result, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { type ClientRaw, RivetError } from "rivetkit/client";
import { describe, expect, it } from "vitest";
import { ActorId, Client } from "../src/index.ts";
import * as Refusal from "../src/refusal.ts";
import type { RawDatabase } from "../src/sqlite-database.ts";
import * as Database from "../src/sqlite-database.ts";
import { Agent } from "./agent.ts";
import { type Refusals, refusal, refusingStorage, standIn } from "./raw-stand-in.ts";

describe("Refusal", () => {
	it("reads the hint of Rivet's error, and none off anything else", () => {
		expect(Refusal.retryAfterMillis(refusal())).toEqual(Option.some(100));
		expect(Refusal.retryAfterMillis(new RivetError("actor", "not_found", "gone"))).toEqual(Option.none());
		expect(Refusal.retryAfterMillis(new RivetError("depot", "overloaded", "x", { metadata: {} }))).toEqual(
			Option.none(),
		);
		expect(
			Refusal.retryAfterMillis(new RivetError("depot", "overloaded", "x", { metadata: { retry_after_ms: "1" } })),
		).toEqual(Option.none());
		expect(Refusal.retryAfterMillis(new Error("The storage host refused the command"))).toEqual(Option.none());
		expect(Refusal.retryAfterMillis(undefined)).toEqual(Option.none());
	});

	it("waits as long as the hint says, up to its limit", () => {
		expect([0, 100, 60_000].map(Refusal.waitMillis)).toEqual([0, 100, Refusal.MAX_WAIT_MILLIS]);
	});
});

/**
 * When each attempt of an Effect that fails with `hints` in turn ran, retried by `Refusal.honouringHint`, and what
 * it failed with in the end. A hint is the failure itself.
 */
const attemptTimes = (hints: (attempt: number) => number | undefined) =>
	Effect.gen(function* () {
		const times: number[] = [];
		const attempt = Effect.flatMap(Clock.currentTimeMillis, (now) => {
			times.push(now);
			return Effect.fail(hints(times.length));
		});
		const failing = Effect.retry(
			attempt,
			Refusal.honouringHint((hint: number | undefined) => Option.fromUndefinedOr(hint)),
		);
		const fiber = yield* Effect.forkChild(Effect.flip(failing), { startImmediately: true });
		yield* TestClock.adjust("1 minute");
		return { times, last: yield* Fiber.join(fiber) };
	});

describe("Refusal.honouringHint", () => {
	it("asks again after each hint, on the clock, the longest wait cut to its limit", () =>
		runTest(
			Effect.gen(function* () {
				const { times, last } = yield* attemptTimes((attempt) => [100, 60_000, 0, undefined][attempt - 1]);
				// The fourth failure has no hint: it goes to the caller at once.
				expect(times).toEqual([0, 100, 100 + Refusal.MAX_WAIT_MILLIS, 100 + Refusal.MAX_WAIT_MILLIS]);
				expect(last).toBeUndefined();
			}),
		));

	it("asks again at most RETRIES more times, then gives the last refusal to the caller", () =>
		runTest(
			Effect.gen(function* () {
				const { times, last } = yield* attemptTimes(() => 100);
				expect(times).toEqual([0, 100, 200, 300, 400, 500]);
				expect(times).toHaveLength(Refusal.RETRIES + 1);
				expect(last).toBe(100);
			}),
		));
});

/** How often each request of the stub was sent. */
interface Sent {
	getOrCreate: number;
	get: number;
	fork: number;
	action: number;
}

/**
 * A stand-in for rivetkit's client that refuses the first `refusals` requests of each kind with `refused`, and then
 * answers as an engine with one idle actor would. A cast: the test gives only what `Client` calls.
 */
function refusing(refusals: number, refused: () => RivetError = refusal) {
	const sent: Sent = { getOrCreate: 0, get: 0, fork: 0, action: 0 };
	const answer = <A>(kind: keyof Sent, value: () => A): Promise<A> => {
		sent[kind] += 1;
		return sent[kind] <= refusals ? Promise.reject(refused()) : Promise.resolve(value());
	};
	const idle = { tasks: 0, background: 0, submissions: 0, active: false, at: null };
	const client = {
		getOrCreate: () => ({ resolve: () => answer("getOrCreate", () => "actor-1") }),
		// No actor holds a fork's key yet.
		get: () => ({ resolve: () => Promise.reject(new RivetError("actor", "not_found", "no such actor")) }),
		fork: () => answer("fork", () => ({ resolve: () => Promise.resolve("fork-1") })),
		getForId: () => ({
			action: ({ name }: { readonly name: string }) =>
				name === "pi.status"
					? Promise.resolve({ _tag: "success", value: idle })
					: answer("action", () => ({ _tag: "success", value: ["user: hello"] })),
		}),
	} as unknown as ClientRaw;
	return { sent, layer: Layer.succeed(Client.RivetClient, client) };
}

/** Runs `request` on the test clock moved a minute on, long enough for every hint of these tests. */
const onTheClock = <A, E>(request: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const fiber = yield* Effect.forkChild(Effect.result(request), { startImmediately: true });
		yield* TestClock.adjust("1 minute");
		return yield* Fiber.join(fiber);
	});

const source: Client.Handle<typeof Agent> = { definition: Agent, actorId: ActorId.make("actor-1"), key: ["source"] };

describe("a client request the engine refuses with a retry hint", () => {
	it("is sent again after each hint until it is served: a lookup, a fork and an action call", () =>
		runTest(
			Effect.gen(function* () {
				const engine = refusing(2);
				const answered = yield* onTheClock(
					Effect.gen(function* () {
						const found = yield* Client.getOrCreate(Agent, ["source"]);
						const fork = yield* Client.fork(source, { key: ["fork"] });
						const transcript = yield* Client.call(source, "transcript", null);
						return { found: found.actorId, fork: fork.actorId, transcript, at: yield* Clock.currentTimeMillis };
					}).pipe(Effect.provide(engine.layer)),
				);
				// Each was refused twice and served the third time, after two hints of 100 ms each.
				expect(answered).toMatchObject({
					success: { found: "actor-1", fork: "fork-1", transcript: ["user: hello"], at: 600 },
				});
				expect(engine.sent).toMatchObject({ getOrCreate: 3, fork: 3, action: 3 });
			}),
		));

	it("gives the refusal to the caller once the attempts are used up", () =>
		runTest(
			Effect.gen(function* () {
				const engine = refusing(Number.POSITIVE_INFINITY);
				const failed = yield* onTheClock(Client.fork(source, { key: ["fork"] }).pipe(Effect.provide(engine.layer)));
				expect(failed).toMatchObject({
					failure: { _tag: "EngineUnavailable", code: "depot.overloaded", retryable: true, retryAfterMillis: 100 },
				});
				expect(engine.sent.fork).toBe(Refusal.RETRIES + 1);
			}),
		));

	it("does not send an action again that the actor itself refused: it may have begun", () =>
		runTest(
			Effect.gen(function* () {
				const engine = refusing(1, () => refusal("actor"));
				const failed = yield* Effect.flip(Client.call(source, "transcript", null)).pipe(
					Effect.provide(engine.layer),
				);
				expect(failed).toMatchObject({
					_tag: "EngineUnavailable",
					code: "actor.overloaded",
					retryAfterMillis: 100,
				});
				expect(engine.sent.action).toBe(1);
			}),
		));

	it("does not send again what failed without a hint", () =>
		runTest(
			Effect.gen(function* () {
				const engine = refusing(
					1,
					() => new RivetError("depot", "request_deadline_exceeded", "its outcome is unknown"),
				);
				const failed = yield* Effect.flip(Client.getOrCreate(Agent, ["source"])).pipe(Effect.provide(engine.layer));
				expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "depot.request_deadline_exceeded" });
				expect(Option.fromUndefinedOr(failed.retryAfterMillis)).toEqual(Option.none());
				expect(engine.sent.getOrCreate).toBe(1);
			}),
		));
});

/**
 * The stand-in database of raw-stand-in.ts behind a storage that refuses (`refusingStorage`). `database` runs its operations
 * on the fibers of a set in the test's scope, so they wait on the test clock; `plain` has no refusals.
 */
const refusingDatabase = (refuse: Refusals, refused: () => unknown = refusal) =>
	Effect.gen(function* () {
		const { raw } = standIn();
		const { raw: refusingRaw, asked } = refusingStorage(raw, refuse, refused);
		const fibers = yield* FiberSet.make();
		const run = yield* FiberSet.runtimePromise(fibers)();
		const plain = Database.make(raw);
		yield* Effect.promise(() => plain.exec(CREATE));
		return { asked, fibers, plain, database: Database.make(refusingRaw, run) };
	});

const CREATE = "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)";

const texts = (executor: SqliteExecutor) =>
	Effect.promise(async () =>
		(await executor.all<{ text: string }>("SELECT text FROM notes ORDER BY id")).map((row) => row.text),
	);

/** What a promise of the adapter rejected with, as it was. */
class Rejected extends Schema.TaggedError<Rejected, { readonly brand: unique symbol }>()("Rejected", {
	cause: Schema.Defect(),
}) {}

/** How a promise of the adapter settled, once the test clock has moved a minute on. */
const settled = <A>(operation: () => Promise<A>) =>
	onTheClock(Effect.tryPromise({ try: operation, catch: (cause) => Rejected.make({ cause }) }));

describe("a statement the storage refuses with a retry hint, inside the actor", () => {
	it("is run again on the database after each hint until it is served, once", () =>
		runTest(
			Effect.gen(function* () {
				const { asked, plain, database } = yield* refusingDatabase({ statements: 2 });
				const done: string[] = [];
				const insert = database
					.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "kept")
					.then(() => done.push("inserted"));
				// One millisecond before each hint has passed, nothing was asked again.
				yield* TestClock.adjust(99);
				expect({ statements: asked.statements, done }).toEqual({ statements: 1, done: [] });
				yield* TestClock.adjust(1);
				expect(asked.statements).toBe(2);
				yield* TestClock.adjust(99);
				expect({ statements: asked.statements, done }).toEqual({ statements: 2, done: [] });
				yield* TestClock.adjust(1);
				yield* Effect.promise(() => insert);
				expect({ statements: asked.statements, done }).toEqual({ statements: 3, done: ["inserted"] });
				expect(yield* texts(plain)).toEqual(["kept"]);
			}),
		));

	it("keeps its turn of the queue while it is asked again", () =>
		runTest(
			Effect.gen(function* () {
				const { plain, database } = yield* refusingDatabase({ statements: 2 });
				// Issued together: the second statement waits for the first, refusals included.
				const both = yield* settled(() =>
					Promise.all([
						database.run("INSERT INTO notes (id, text) VALUES (1, 'first')"),
						database.run("UPDATE notes SET text = text || '!'"),
					]),
				);
				expect(Result.isSuccess(both)).toBe(true);
				expect(yield* texts(plain)).toEqual(["first!"]);
			}),
		));

	it("runs a counted statement again as a whole, with the count of the run that was kept", () =>
		runTest(
			Effect.gen(function* () {
				const { asked, plain, database } = yield* refusingDatabase({ inside: 1 });
				yield* Effect.promise(() => plain.run("INSERT INTO notes (id, text) VALUES (1, 'a'), (2, 'b')"));
				// The statement inside the counting transaction is refused once: Rivet rolls that transaction back.
				const counted = yield* settled(() => database.runCounted("UPDATE notes SET text = text || '!'"));
				expect(Result.getOrUndefined(counted)).toBe(2);
				expect(asked.transactions).toBe(2);
				expect(yield* texts(plain)).toEqual(["a!", "b!"]);
			}),
		));

	it("starts a transaction again that was refused before its callback was called", () =>
		runTest(
			Effect.gen(function* () {
				const { asked, plain, database } = yield* refusingDatabase({ begins: 2 });
				let called = 0;
				yield* settled(() =>
					database.transaction(async (transaction) => {
						called += 1;
						await transaction.run("INSERT INTO notes (id, text) VALUES (1, 'once')");
					}),
				);
				expect({ called, transactions: asked.transactions }).toEqual({ called: 1, transactions: 3 });
				expect(yield* texts(plain)).toEqual(["once"]);
			}),
		));

	it("never asks again in the middle of a transaction: the refusal rolls it back and reaches the caller", () =>
		runTest(
			Effect.gen(function* () {
				const { asked, plain, database } = yield* refusingDatabase({ inside: 1 });
				let called = 0;
				const rejected = yield* settled(() =>
					database.transaction(async (transaction) => {
						called += 1;
						await transaction.run("INSERT INTO notes (id, text) VALUES (1, 'first')");
						await transaction.run("INSERT INTO notes (id, text) VALUES (2, 'second')");
					}),
				);
				// The first statement of the transaction was the refused one; the callback ran once and is not run again.
				expect(Refusal.retryAfterMillis(failureOf(rejected))).toEqual(Option.some(100));
				expect({ called, transactions: asked.transactions }).toEqual({ called: 1, transactions: 1 });
				expect(yield* texts(plain)).toEqual([]);
			}),
		));

	it("gives up after its attempts, and does not ask again what failed without a hint", () =>
		runTest(
			Effect.gen(function* () {
				const always = yield* refusingDatabase({ statements: Number.POSITIVE_INFINITY });
				const rejected = yield* settled(() => always.database.run("INSERT INTO notes (id) VALUES (1)"));
				expect(Refusal.retryAfterMillis(failureOf(rejected))).toEqual(Option.some(100));
				expect(always.asked.statements).toBe(Refusal.RETRIES + 1);

				const unknown = yield* refusingDatabase(
					{ statements: 1 },
					() => new RivetError("sqlite", "indeterminate", "lost"),
				);
				const lost = yield* settled(() => unknown.database.run("INSERT INTO notes (id) VALUES (1)"));
				expect(failureOf(lost)).toMatchObject({ group: "sqlite", code: "indeterminate" });
				expect(unknown.asked.statements).toBe(1);
			}),
		));
});

describe("the adapter's fibers interrupted while a refused statement waits out its hint", () => {
	it("ends the wait at once: the statement and those queued behind it reject, and none is asked again", () =>
		runTest(
			Effect.gen(function* () {
				// A hint of five seconds, and the clock never moves: only the interruption can end the wait.
				const { asked, fibers, plain, database } = yield* refusingDatabase({ statements: 1 }, () =>
					refusal("depot", 5_000),
				);
				const outcomes: string[] = [];
				const record = (name: string, operation: Promise<unknown>) =>
					operation.then(
						() => outcomes.push(`${name} ran`),
						() => outcomes.push(`${name} rejected`),
					);
				const waiting = record("refused", database.run("INSERT INTO notes (id, text) VALUES (1, 'refused')"));
				const queued = record("queued", database.run("INSERT INTO notes (id, text) VALUES (2, 'queued')"));
				yield* Effect.yieldNow;
				expect(asked.statements).toBe(1);
				yield* FiberSet.clear(fibers);
				yield* Effect.promise(() => Promise.all([waiting, queued]));
				expect(outcomes.sort()).toEqual(["queued rejected", "refused rejected"]);
				expect(asked.statements).toBe(1);
				expect(yield* Clock.currentTimeMillis).toBe(0);
				// What is asked for afterwards runs: the clear ended the fibers it found, not the adapter.
				yield* Effect.promise(() => database.run("INSERT INTO notes (id, text) VALUES (3, 'after')"));
				expect(yield* texts(plain)).toEqual(["after"]);
			}),
		));

	it("waits for a statement Rivet is running before it ends, so the queue never has two at Rivet", () =>
		runTest(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const run = yield* Scope.provide(scope)(FiberSet.makeRuntimePromise());
				const { raw } = standIn();
				const answer = Promise.withResolvers<void>();
				const log: string[] = [];
				const slow: RawDatabase = {
					execute: async (query, ...args) => {
						log.push("rivet runs");
						await answer.promise;
						log.push("rivet answers");
						return raw.execute(query, ...args);
					},
					transaction: (callback, options) => raw.transaction(callback, options),
				};
				const running = Database.make(slow, run)
					.exec(CREATE)
					.catch(() => log.push("rejected"));
				const closing = yield* Effect.forkChild(
					Effect.andThen(
						Scope.close(scope, Exit.void),
						Effect.sync(() => log.push("closed")),
					),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				expect(log).toEqual(["rivet runs"]);
				answer.resolve();
				yield* Fiber.join(closing);
				yield* Effect.promise(() => running);
				// The close ended after Rivet answered; the statement ran, and its caller was told it was interrupted.
				expect(log.slice(0, 2)).toEqual(["rivet runs", "rivet answers"]);
				expect(log.slice(2).sort()).toEqual(["closed", "rejected"]);
			}),
		));
});

/** What a settled promise of these tests rejected with; undefined when it resolved. */
function failureOf<A>(outcome: Result.Result<A, Rejected>): unknown {
	return Option.getOrUndefined(Option.map(Result.getFailure(outcome), (rejected) => rejected.cause));
}
