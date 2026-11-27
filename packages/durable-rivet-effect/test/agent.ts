// Test helper: the actors the engine suite hosts. `Agent` is an actor of this package on a scripted model, with
// harness options made from a service of its `layer` and an action that works with actors from inside one; `Raw` is
// a bare Rivet actor that runs Pi's storage conformance suite, the adapter's checks and those of `ActorSql` on a real
// actor database.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createExpectAssertions, createStorageConformance, type ExpectLike } from "@earendil-works/pi-durable/testing";
import { Doc, Extension, Gate, Harness, Hook, Registry, Storage, Task, Tool } from "@effectified/pi-durable";
import {
	answer,
	type FauxResponseFactory,
	ScriptedModels,
	TestHarness,
	toolCall,
} from "@effectified/pi-durable/testing";
import { Context, Deferred, Effect, Fiber, FiberSet, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { type ActorContext, type AnyActorDefinition, actor } from "rivetkit";
import { type DatabaseProvider, db, type RawAccess } from "rivetkit/db";
import * as Sql from "../src/actor-sql.ts";
import { Action, Actor, ActorInfo, Client, Fork, Self, SqliteDatabase } from "../src/index.ts";

/** How far ahead the gate of the `slow` tool parks its call: the real time the wake test waits. */
export const PARK_MILLIS = 2_500;

/**
 * The model of the test actors holds a request whose prompt is `hold <name>` until the gate of that name is released:
 * the test and the actors share a process, so a test opens the gate itself.
 */
export function gate(name: string): { readonly requested: Promise<void>; readonly release: () => void } {
	const { requested, held } = gateOf(name);
	return { requested: requested.promise, release: () => held.resolve() };
}

const gates = new Map<
	string,
	{ readonly requested: PromiseWithResolvers<void>; readonly held: PromiseWithResolvers<void> }
>();

function gateOf(name: string) {
	const existing = gates.get(name);
	if (existing !== undefined) return existing;
	const made = { requested: Promise.withResolvers<void>(), held: Promise.withResolvers<void>() };
	gates.set(name, made);
	return made;
}

/** A service of the test's product: what the harness options of the test actors are made from. */
class Product extends Context.Service<Product, { readonly name: string }>()("test/Product") {}

/**
 * What the harness options of the test actors did, in order: `<actor id>:options from <product>` each time the
 * options were made, which is once per wake, and `<actor id>:conversation` for each conversation their
 * `conversationCreated` was called for.
 */
export const configured: string[] = [];

/** Harness options that need a service of `layer`: an Effect, run once `layer` is built. */
const harness = Effect.gen(function* () {
	const product = yield* Product;
	const { actorId } = yield* ActorInfo;
	configured.push(`${actorId}:options from ${product.name}`);
	return {
		conversationCreated: () => Effect.sync(() => void configured.push(`${actorId}:conversation`)),
	};
});

const Slow = Tool.make("slow", {
	description: "Answers after a while.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
	replay: "safe",
	handler: ({ text }) => Effect.succeed(`done ${text}`),
});

// Parks the call of `slow` until a time fixed once, in a memo: the wake at that time lets it through.
const Timed = Hook.beforeTool((call, api) =>
	Effect.gen(function* () {
		if (call.name !== "slow") return Gate.allow;
		const until = yield* api.memo("test.until", (yield* api.now) + PARK_MILLIS);
		return (yield* api.now) >= until ? Gate.allow : Gate.park({ until });
	}),
);

/**
 * A task of the product that sleeps for ten minutes, holding no process, and does nothing else: as a background task
 * it is live work with nothing in flight, which a fork may copy.
 */
const Linger = Task.make({
	name: "test.linger",
	version: 1,
	input: Schema.Struct({}),
	state: Schema.Union([
		Schema.Struct({ phase: Schema.Literal("start") }),
		Schema.Struct({ phase: Schema.Literal("asleep") }),
	]),
	result: Schema.Null,
	initial: () => ({ phase: "start" as const }),
	phases: {
		start: (_task, api) => Effect.map(api.now, (now) => Task.sleepUntil(now + 600_000, { phase: "asleep" as const })),
		asleep: () => Effect.succeed(Task.complete(null)),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

/** A model that reads its answer off the request: no queue to run dry, and the same answer after any restart. */
const respond: FauxResponseFactory = async (context) => {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return answer(`the tool said: ${textOf(last)}`);
	const prompt = last === undefined ? "" : textOf(last);
	if (prompt.startsWith("slow")) return toolCall("slow", { text: prompt }, { id: "call-slow" });
	if (prompt.startsWith("hold ")) {
		const held = gateOf(prompt.slice("hold ".length));
		held.requested.resolve();
		await held.held.promise;
	}
	// The count shows how much of a transcript the model was given: a fork continues its parent's count.
	const asked = context.messages.filter((message) => message.role === "user").length;
	return answer(`answer ${asked}: ${prompt}`);
};

function textOf(message: Message | AssistantMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const scripted = Layer.effectDiscard(
	ScriptedModels.use((models) => models.setResponses(Array.from({ length: 64 }, () => respond))),
).pipe(Layer.provideMerge(ScriptedModels.layer({ api: "scripted" })));

/** What the fork hygiene of the test actor wrote, in the order its steps ran. */
const Hygiene = Doc.make({
	kind: "test.hygiene",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ steps: Schema.Array(Schema.String) }),
	initial: () => ({ steps: [] }),
	checkpointWhen: () => false,
});

const hygieneStep = (step: string): Fork.Hygiene<never> =>
	Effect.gen(function* () {
		const { forkInput } = yield* ActorInfo;
		yield* Harness.commit((tx) =>
			Effect.flatMap(tx.doc(Hygiene), (doc) =>
				doc.update(({ steps }) => ({
					steps: [...steps, `${step} ${JSON.stringify(Option.getOrNull(forkInput))}`],
				})),
			),
		);
	});

/** An action failure of the product's own. */
export class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
	reason: Schema.String,
}) {}

const root = Effect.orDie(TestHarness.root);

/** The model's context of the root conversation, one line per message, without the system prompt. */
const transcript = Effect.orDie(
	Effect.gen(function* () {
		const view = yield* (yield* root).context();
		return view.messages
			.filter((message) => message.role !== "system")
			.map((message) => `${message.role}: ${textOf(message)}`);
	}),
);

const Prompt = Schema.Struct({ text: Schema.String, requestId: Schema.String });

/** The actor under test: a harness on a scripted model, with a tool whose call parks, and two hygiene steps. */
export const Agent = agent("agent", { sleepTimeout: 60_000, actionTimeout: 30_000 });

/** The same actor with Rivet's shortest useful idle time: it sleeps by itself a second after its last work. */
export const Napper = agent("napper", { sleepTimeout: 1_000, actionTimeout: 30_000 });

function agent<const Name extends string>(
	name: Name,
	options: { readonly sleepTimeout: number; readonly actionTimeout: number },
) {
	return Actor.make(name, {
		layer: Layer.mergeAll(
			Registry.layer([Extension.make({ name: "test", tools: [Slow], hooks: [Timed], tasks: [Linger] })]),
			scripted,
			Layer.succeed(Product, { name: "the test product" }),
			// Rivet's client of the engine the actor runs on: no endpoint is passed in.
			Self.client,
		).pipe(Layer.orDie),
		harness,
		forkHygiene: [hygieneStep("first"), hygieneStep("second")],
		options,
		actions: {
			/** Prompts the root conversation and waits for the answer. */
			ask: Action.make({
				input: Prompt,
				output: Schema.Array(Schema.String),
				handler: ({ text, requestId }) =>
					Effect.gen(function* () {
						yield* Effect.orDie((yield* root).prompt(text, { requestId }));
						return yield* transcript;
					}),
			}),
			/** Admits a prompt and returns at once: the run goes on in the actor. */
			submit: Action.make({
				input: Prompt,
				output: Schema.Null,
				handler: ({ text, requestId }) =>
					Effect.as(
						Effect.orDie(
							Effect.flatMap(root, (conversation) =>
								conversation.submit({ type: "input", content: text, requestId }),
							),
						),
						null,
					),
			}),
			transcript: Action.make({
				input: Schema.Null,
				output: Schema.Array(Schema.String),
				handler: () => transcript,
			}),
			/** Starts a task of the root conversation that sleeps for ten minutes, as a background task or not. */
			linger: Action.make({
				input: Schema.Struct({ background: Schema.Boolean }),
				output: Schema.Null,
				handler: ({ background }) =>
					Effect.as(
						Effect.orDie(
							Effect.flatMap(root, (conversation) =>
								conversation.commit((tx) =>
									tx.createTask(Linger, {}, { ownership: { kind: "conversation" }, background }),
								),
							),
						),
						null,
					),
			}),
			hygiene: Action.make({
				input: Schema.Null,
				output: Schema.Array(Schema.String),
				handler: () =>
					Effect.map(Effect.orDie(Harness.snapshot(Hygiene)), (found) =>
						Option.match(found, { onNone: () => [], onSome: ({ steps }) => steps }),
					),
			}),
			lineage: Action.make({
				input: Schema.Null,
				output: Schema.Struct({ sources: Schema.Array(Schema.String), input: Schema.Option(Schema.Json) }),
				handler: () =>
					Effect.map(Fork.lineage, ({ chain, input }) => ({ sources: chain.map((link) => link.actorId), input })),
			}),
			/** From inside the actor: its own handle, where it came from, and the actor of its definition under a key. */
			inside: Action.make({
				input: Schema.Struct({ sibling: Schema.Array(Schema.String) }),
				output: Schema.Struct({
					own: Schema.String,
					key: Schema.Array(Schema.String),
					sources: Schema.Number,
					sibling: Schema.Option(Schema.String),
				}),
				handler: ({ sibling }) =>
					Effect.gen(function* () {
						const own = yield* Self.handle({});
						const lineage = yield* Client.lineage(own);
						const found = yield* Self.find({}, sibling);
						return {
							own: own.actorId,
							key: own.key,
							sources: lineage.chain.length,
							sibling: Option.map(found, (handle) => handle.actorId),
						};
					}).pipe(Effect.orDie),
			}),
			refuse: Action.make({
				input: Schema.Struct({ reason: Schema.String }),
				output: Schema.Null,
				error: Refused,
				handler: ({ reason }) => Effect.fail(new Refused({ reason })),
			}),
			crash: Action.make({
				input: Schema.Null,
				output: Schema.Null,
				handler: () => Effect.die(new Error("the handler broke")),
			}),
		},
	});
}

/** The context Rivet gives the hooks and actions of the actors of this file. */
type Cell = ActorContext<unknown, unknown, unknown, unknown, unknown, DatabaseProvider<RawAccess>>;

/** A bare Rivet actor with a database: what the adapter and Pi's storage do on the real thing. */
export function raw(expect: ExpectLike): AnyActorDefinition {
	return actor({
		db: db(),
		options: { actionTimeout: 120_000 },
		actions: {
			/** Runs every case of Pi's storage conformance suite, each on a storage under a prefix of its own. */
			conformance: async (c: Cell) => {
				const database = SqliteDatabase.make(c.db);
				let opened = 0;
				const cases = createStorageConformance({
					assertions: createExpectAssertions(expect),
					withStorage: async (use) => use(await SqliteStorage.open(database, { prefix: `case${opened++}_` })),
				});
				const failures: string[] = [];
				for (const testCase of cases) {
					await testCase.run().catch((error: unknown) => failures.push(`${testCase.name}: ${String(error)}`));
				}
				return { cases: cases.length, failures };
			},
			/** The same suite on `Storage.sql` over `ActorSql`, each case on a client and a prefix of its own. */
			conformanceSql: async (c: Cell) => {
				let opened = 0;
				const cases = createStorageConformance({
					assertions: createExpectAssertions(expect),
					withStorage: (use) =>
						Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const sql = yield* Sql.make(c.db, yield* Semaphore.make(1), yield* FiberSet.make());
									yield* Storage.HarnessStorage.use((storage) => Effect.promise(() => use(storage))).pipe(
										Effect.provide(Storage.sql({ prefix: `sql${opened++}_` })),
										Effect.provideService(SqlClient.SqlClient, sql),
									);
								}),
							),
						),
				});
				const failures: string[] = [];
				for (const testCase of cases) {
					await testCase.run().catch((error: unknown) => failures.push(`${testCase.name}: ${String(error)}`));
				}
				return { cases: cases.length, failures };
			},
			/**
			 * `ActorSql`'s transactions on the actor's database: one committed, one rolled back by its failure, a nested
			 * one rolled back alone, one whose fiber is interrupted, and the adapter's statement waiting on the same queue.
			 */
			sqlTransactions: (c: Cell) =>
				Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const queue = yield* Semaphore.make(1);
							const work = yield* FiberSet.make();
							const sql = yield* Sql.make(c.db, queue, work);
							const database = SqliteDatabase.make(c.db, yield* FiberSet.runtimePromise(work)(), queue);
							const insert = (id: number, text: string) =>
								sql`INSERT INTO sql_notes ${sql.insert({ id, text })}`;
							yield* sql`CREATE TABLE IF NOT EXISTS sql_notes (id INTEGER PRIMARY KEY, text TEXT)`;
							yield* sql.withTransaction(insert(1, "committed"));
							const failed = yield* Effect.flip(
								sql.withTransaction(Effect.andThen(insert(2, "failed"), Effect.fail("the body failed"))),
							);
							yield* sql.withTransaction(
								Effect.andThen(
									insert(3, "outer"),
									Effect.exit(sql.withTransaction(Effect.andThen(insert(4, "inner"), Effect.fail("inner")))),
								),
							);
							const inside = yield* Deferred.make<void>();
							const interrupted = yield* Effect.forkChild(
								sql.withTransaction(
									Effect.andThen(
										Effect.andThen(insert(5, "interrupted"), Deferred.succeed(inside, undefined)),
										Effect.never,
									),
								),
							);
							yield* Deferred.await(inside);
							// While the interrupted transaction holds the queue, the adapter's statement waits for it.
							const adapter = database.run("INSERT INTO sql_notes (id, text) VALUES (6, 'adapter')");
							yield* Fiber.interrupt(interrupted);
							yield* Effect.promise(() => adapter);
							const rows = yield* sql<{ readonly text: string }>`SELECT text FROM sql_notes ORDER BY id`;
							return { failed, rows: rows.map((row) => row.text) };
						}),
					),
				),
			/**
			 * What Chord's contract asks of a transaction, through the adapter, on the actor's database. Without the
			 * adapter's queue the statement issued second usually ends while the first transaction is still open.
			 */
			transactions: async (c: Cell) => {
				const database = SqliteDatabase.make(c.db);
				await database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
				const started: string[] = [];
				const gate = Promise.withResolvers<void>();
				const first = database.transaction(async (transaction) => {
					await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 1, "inside");
					await gate.promise;
				});
				const outside = database.run("INSERT INTO notes (id, text) VALUES (?, ?)", 2, "outside").then(() => {
					started.push("statement");
				});
				// What the second transaction finds when it starts, and how many rows its statement changes.
				const second = database.transaction(async (transaction) => {
					started.push("second transaction");
					const found = await transaction.all<{ text: string }>("SELECT text FROM notes ORDER BY id");
					return {
						found: found.map((row) => row.text),
						counted: await transaction.runCounted("UPDATE notes SET text = text || '!'"),
					};
				});
				await new Promise((resolve) => setTimeout(resolve, 100));
				const whileOpen = [...started];
				gate.resolve();
				const { found, counted } = await second;
				await Promise.all([first, outside]);
				const failure = new Error("callback failed");
				const rejected = await database
					.transaction(async (transaction) => {
						await transaction.run("INSERT INTO notes (id, text) VALUES (?, ?)", 3, "dropped");
						throw failure;
					})
					.catch((error: unknown) => error);
				let kept: { run(sql: string): Promise<void> } | undefined;
				await database.transaction(async (transaction) => {
					kept = transaction;
				});
				const late = await kept?.run("INSERT INTO notes (id, text) VALUES (4, 'late')").then(
					() => "accepted",
					() => "rejected",
				);
				return {
					whileOpen,
					found,
					counted,
					countedOnDatabase: await database.runCounted("DELETE FROM notes WHERE id = ?", 2),
					sameError: rejected === failure,
					late,
					rows: (await database.all<{ text: string }>("SELECT text FROM notes ORDER BY id")).map(
						(row) => row.text,
					),
				};
			},
		},
	});
}
