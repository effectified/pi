// A refusal with a retry hint, with the refusal injected: every place that can meet one asks again a bounded number
// of times, and no place repeats what may have run. The refusal is Rivet's own, as it was caught on a local engine:
// `depot.overloaded` with the reason `volume_transition` and a hint of 100 milliseconds, answered to a fork.

import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { Effect, Layer, Option } from "effect";
import { type ClientRaw, RivetError } from "rivetkit/client";
import { describe, expect, it } from "vitest";
import { Client } from "../src/index.ts";
import * as Refusal from "../src/refusal.ts";
import type { RawDatabase } from "../src/sqlite-database.ts";
import * as Database from "../src/sqlite-database.ts";
import { Agent } from "./agent.ts";
import { standIn } from "./raw-stand-in.ts";

/** Rivet's refusal, with a hint of one millisecond so the tests do not wait. */
const refusal = (group = "depot"): RivetError =>
	new RivetError(group, "overloaded", "The storage host refused the command (volume_transition); retry after 1 ms.", {
		metadata: { reason: "volume_transition", retry_after_ms: 1 },
	});

describe("Refusal", () => {
	it("reads the hint of Rivet's error, and none off anything else", () => {
		expect(Refusal.retryAfterMillis(refusal())).toBe(1);
		expect(Refusal.retryAfterMillis(new RivetError("actor", "not_found", "gone"))).toBeUndefined();
		expect(Refusal.retryAfterMillis(new RivetError("depot", "overloaded", "x", { metadata: {} }))).toBeUndefined();
		expect(
			Refusal.retryAfterMillis(new RivetError("depot", "overloaded", "x", { metadata: { retry_after_ms: "1" } })),
		).toBeUndefined();
		expect(Refusal.retryAfterMillis(new Error("The storage host refused the command"))).toBeUndefined();
		expect(Refusal.retryAfterMillis(undefined)).toBeUndefined();
	});

	it("waits as long as the hint says, up to its limit", () => {
		expect([0, 100, 60_000].map(Refusal.waitMillis)).toEqual([0, 100, Refusal.MAX_WAIT_MILLIS]);
	});
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

const source: Client.Handle<typeof Agent> = { definition: Agent, actorId: "actor-1", key: ["source"] };

describe("a client request the engine refuses with a retry hint", () => {
	it("is sent again until it is served: a lookup, a fork and an action call", async () => {
		const engine = refusing(2);
		const answered = await Effect.runPromise(
			Effect.gen(function* () {
				const found = yield* Client.getOrCreate(Agent, ["source"]);
				const fork = yield* Client.fork(source, { key: ["fork"] });
				const transcript = yield* Client.call(source, "transcript", null);
				return { found: found.actorId, fork: fork.actorId, transcript };
			}).pipe(Effect.provide(engine.layer)),
		);
		expect(answered).toEqual({ found: "actor-1", fork: "fork-1", transcript: ["user: hello"] });
		// Each was refused twice and served the third time.
		expect(engine.sent).toMatchObject({ getOrCreate: 3, fork: 3, action: 3 });
	});

	it("gives the refusal to the caller once the attempts are used up", async () => {
		const engine = refusing(Number.POSITIVE_INFINITY);
		const failed = await Effect.runPromise(
			Effect.flip(Client.fork(source, { key: ["fork"] })).pipe(Effect.provide(engine.layer)),
		);
		expect(failed).toMatchObject({
			_tag: "EngineUnavailable",
			code: "depot.overloaded",
			retryable: true,
			retryAfterMillis: 1,
		});
		expect(engine.sent.fork).toBe(Refusal.RETRIES + 1);
	});

	it("does not send an action again that the actor itself refused: it may have begun", async () => {
		const engine = refusing(1, () => refusal("actor"));
		const failed = await Effect.runPromise(
			Effect.flip(Client.call(source, "transcript", null)).pipe(Effect.provide(engine.layer)),
		);
		expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "actor.overloaded", retryAfterMillis: 1 });
		expect(engine.sent.action).toBe(1);
	});

	it("does not send again what failed without a hint", async () => {
		const engine = refusing(1, () => new RivetError("depot", "request_deadline_exceeded", "its outcome is unknown"));
		const failed = await Effect.runPromise(
			Effect.flip(Client.getOrCreate(Agent, ["source"])).pipe(Effect.provide(engine.layer)),
		);
		expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "depot.request_deadline_exceeded" });
		expect(Option.fromUndefinedOr(failed.retryAfterMillis)).toEqual(Option.none());
		expect(engine.sent.getOrCreate).toBe(1);
	});
});

/** What the refusing database did. */
interface Asked {
	/** Statements asked for on the database itself, refused ones included. */
	statements: number;
	/** Transactions asked for, refused ones included. */
	transactions: number;
}

/**
 * The stand-in database of raw-stand-in.ts behind a storage that refuses: the next `statements` statements on the
 * database, the next `begins` transactions before their callback is called, and the next `inside` statements inside
 * a transaction. A refused request does nothing, as Rivet's storage says of its own.
 */
function refusingDatabase(refuse: { statements?: number; begins?: number; inside?: number }, refused = refusal) {
	const { raw } = standIn();
	const left = { statements: refuse.statements ?? 0, begins: refuse.begins ?? 0, inside: refuse.inside ?? 0 };
	const asked: Asked = { statements: 0, transactions: 0 };
	const take = (kind: keyof typeof left): boolean => {
		if (left[kind] <= 0) return false;
		left[kind] -= 1;
		return true;
	};
	const refusingRaw: RawDatabase = {
		execute: (query, ...args) => {
			asked.statements += 1;
			return take("statements") ? Promise.reject(refused()) : raw.execute(query, ...args);
		},
		transaction: (callback, options) => {
			asked.transactions += 1;
			if (take("begins")) return Promise.reject(refused());
			return raw.transaction(
				(transaction) =>
					callback({
						execute: (query, ...args) =>
							take("inside") ? Promise.reject(refused()) : transaction.execute(query, ...args),
						transaction: (nested, nestedOptions) => transaction.transaction(nested, nestedOptions),
					}),
				options,
			);
		},
	};
	return { asked, plain: Database.make(raw), database: Database.make(refusingRaw) };
}

const texts = async (executor: SqliteExecutor): Promise<Array<string>> =>
	(await executor.all<{ text: string }>("SELECT text FROM notes ORDER BY id")).map((row) => row.text);

const CREATE = "CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)";

describe("a statement the storage refuses with a retry hint, inside the actor", () => {
	it("is run again on the database until it is served, once", async () => {
		const { asked, plain, database } = refusingDatabase({ statements: 2 });
		await plain.exec(CREATE);
		await database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "kept");
		expect(asked.statements).toBe(3);
		expect(await texts(plain)).toEqual(["kept"]);
	});

	it("keeps its turn of the queue while it is asked again", async () => {
		const { plain, database } = refusingDatabase({ statements: 2 });
		await plain.exec(CREATE);
		// Issued together: the second statement waits for the first, refusals included.
		await Promise.all([
			database.run("INSERT INTO notes (id, text) VALUES (1, 'first')"),
			database.run("UPDATE notes SET text = text || '!'"),
		]);
		expect(await texts(plain)).toEqual(["first!"]);
	});

	it("runs a counted statement again as a whole, with the count of the run that was kept", async () => {
		const { asked, plain, database } = refusingDatabase({ inside: 1 });
		await plain.exec(CREATE);
		await plain.run("INSERT INTO notes (id, text) VALUES (1, 'a'), (2, 'b')");
		// The statement inside the counting transaction is refused once: Rivet rolls that transaction back.
		expect(await database.runCounted("UPDATE notes SET text = text || '!'")).toBe(2);
		expect(asked.transactions).toBe(2);
		expect(await texts(plain)).toEqual(["a!", "b!"]);
	});

	it("starts a transaction again that was refused before its callback was called", async () => {
		const { asked, plain, database } = refusingDatabase({ begins: 2 });
		await plain.exec(CREATE);
		let called = 0;
		await database.transaction(async (transaction) => {
			called += 1;
			await transaction.run("INSERT INTO notes (id, text) VALUES (1, 'once')");
		});
		expect({ called, transactions: asked.transactions }).toEqual({ called: 1, transactions: 3 });
		expect(await texts(plain)).toEqual(["once"]);
	});

	it("never asks again in the middle of a transaction: the refusal rolls it back and reaches the caller", async () => {
		const { asked, plain, database } = refusingDatabase({ inside: 1 });
		await plain.exec(CREATE);
		let called = 0;
		const rejected = await database
			.transaction(async (transaction) => {
				called += 1;
				await transaction.run("INSERT INTO notes (id, text) VALUES (1, 'first')");
				await transaction.run("INSERT INTO notes (id, text) VALUES (2, 'second')");
			})
			.catch((error: unknown) => error);
		// The first statement of the transaction was the refused one; the callback ran once and is not run again.
		expect(Refusal.retryAfterMillis(rejected)).toBe(1);
		expect({ called, transactions: asked.transactions }).toEqual({ called: 1, transactions: 1 });
		expect(await texts(plain)).toEqual([]);
	});

	it("gives up after its attempts, and does not ask again what failed without a hint", async () => {
		const always = refusingDatabase({ statements: Number.POSITIVE_INFINITY });
		const rejected = await always.database.exec(CREATE).catch((error: unknown) => error);
		expect(Refusal.retryAfterMillis(rejected)).toBe(1);
		expect(always.asked.statements).toBe(Refusal.RETRIES + 1);

		const unknown = refusingDatabase({ statements: 1 }, () => new RivetError("sqlite", "indeterminate", "lost"));
		const lost = await unknown.database.exec(CREATE).catch((error: unknown) => error);
		expect(lost).toMatchObject({ group: "sqlite", code: "indeterminate" });
		expect(unknown.asked.statements).toBe(1);
	});
});
