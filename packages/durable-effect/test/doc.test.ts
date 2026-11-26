import {
	type ConversationId,
	type DocumentObserver,
	defineDoc,
	defineDocFamily,
	type EntryId,
	type TaskId,
	type WatchHandle,
} from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Doc, type DurableError, Harness } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, harnessLayer } from "./scripted.ts";

const Todos = Doc.make({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	schema: Schema.Struct({ items: Schema.Array(Schema.String), due: Schema.Date }),
	initial: () => ({ items: [], due: new Date(0) }),
	checkpointWhen: () => false,
});

const Counter = Doc.make({
	kind: "app.counter",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ count: Schema.Number.check(Schema.isLessThan(3)) }),
	initial: () => ({ count: 0 }),
	checkpointWhen: () => true,
});

const Notes = Doc.family({
	kind: "app.notes",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	schema: Schema.Struct({ author: Schema.String, lines: Schema.Array(Schema.String) }),
	initial: (author: string) => ({ author, lines: [] }),
	checkpointWhen: () => false,
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const run = <A, E>(effect: Effect.Effect<A, E, Harness.Harness>) =>
	Effect.runPromise(Effect.provide(effect, harnessLayer({})));

describe("make and family", () => {
	it("infer the value from the schema, and the address and the seed from the definition", () => {
		const value: Equal<Doc.Value<typeof Todos>, { readonly items: ReadonlyArray<string>; readonly due: Date }> = true;
		const conversation: Equal<Doc.Address<typeof Todos>, [conversationId: ConversationId]> = true;
		const session: Equal<Doc.Address<typeof Counter>, []> = true;
		const member: Equal<Doc.Address<typeof Notes>, [conversationId: ConversationId, key: string]> = true;
		const opening: Equal<
			Doc.Opening<typeof Notes>,
			[conversationId: ConversationId, key: string, seed: string]
		> = true;
		const read: Equal<
			ReturnType<typeof Harness.snapshot<typeof Todos>>,
			Effect.Effect<
				Option.Option<{ readonly items: ReadonlyArray<string>; readonly due: Date }>,
				DurableError | SchemaDecodeError,
				Harness.Harness
			>
		> = true;
		expect([value, conversation, session, member, opening, read]).toEqual([true, true, true, true, true, true]);
		// @ts-expect-error A conversation document needs the conversation's id.
		expect(Harness.snapshot(Todos)).toBeDefined();
		// @ts-expect-error Only a rewindable conversation document has older values.
		expect(Harness.snapshotAsOf(Counter, 1 as EntryId)).toBeDefined();
		expect(Todos).toMatchObject({ kind: "app.todos", version: 1, scope: "conversation", history: "rewindable" });
		expect(Notes).toMatchObject({ kind: "app.notes", scope: "conversation", history: "latest", family: true });
	});

	it("give Pi a definition that stores the JSON form of the value", () => {
		const definition = Todos.token.definition as unknown as { readonly initial: () => unknown };
		expect(definition.initial()).toEqual({ items: [], due: "1970-01-01T00:00:00.000Z" });
		expect(Todos.token.definition).toMatchObject({ kind: "app.todos", version: 1, fork: "asOf" });
	});
});

describe("a document in a commit", () => {
	it("is created from `initial`, encoded on write and decoded on read", async () => {
		const due = new Date("2026-12-01T00:00:00.000Z");
		const outcome = await run(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const absent = yield* Harness.snapshot(Todos, root.id);
				const inside = yield* root.commit((tx) =>
					Effect.gen(function* () {
						const todos = yield* tx.doc(Todos, root.id);
						const initial = yield* todos.get;
						yield* todos.set({ items: ["write docs"], due });
						yield* todos.update((value) => ({ ...value, items: [...value.items, "ship"] }));
						return { initial, draft: JSON.parse(JSON.stringify(todos.draft)) as unknown, now: yield* todos.get };
					}),
				);
				return {
					absent: Option.isNone(absent),
					inside,
					read: Option.getOrThrow(yield* Harness.snapshot(Todos, root.id)),
				};
			}),
		);
		expect(outcome.absent).toBe(true);
		expect(outcome.inside.initial).toEqual({ items: [], due: new Date(0) });
		expect(outcome.inside.draft).toEqual({ items: ["write docs", "ship"], due: "2026-12-01T00:00:00.000Z" });
		expect(outcome.inside.now).toEqual({ items: ["write docs", "ship"], due });
		expect(outcome.read).toEqual({ items: ["write docs", "ship"], due });
		expect(outcome.read.due).toBeInstanceOf(Date);
	});

	it("takes edits of Pi's draft in place, and deletes the fields a new value lacks", async () => {
		const Loose = Doc.make({
			kind: "app.loose",
			version: 1,
			scope: "session",
			schema: Schema.Struct({ items: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) }),
			initial: () => ({ items: ["a"], note: "first" }),
			checkpointWhen: () => false,
		});
		const value = await run(
			Effect.gen(function* () {
				yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						const loose = yield* tx.doc(Loose);
						(loose.draft.items as string[]).push("b");
						yield* loose.update((current) => ({ items: current.items }));
					}),
				);
				return Option.getOrThrow(yield* Harness.snapshot(Loose));
			}),
		);
		expect(value).toEqual({ items: ["a", "b"] });
	});

	it("reads a value that stays whole after the commit, even where the schema keeps what it decoded", async () => {
		const Raw = Doc.make({
			kind: "app.raw",
			version: 1,
			scope: "session",
			schema: Schema.Struct({ payload: Schema.Json }),
			initial: () => ({ payload: { nested: { list: [1, 2] } } }),
			checkpointWhen: () => false,
		});
		// Pi revokes its draft when the body ends: a value holding a part of it could not be read afterwards.
		const value = await run(Harness.commit((tx) => Effect.flatMap(tx.doc(Raw), (raw) => raw.get)));
		expect(value).toEqual({ payload: { nested: { list: [1, 2] } } });
	});

	it("fails with SchemaDecodeError for a value the schema rejects, on write and on read", async () => {
		const outcome = await run(
			Effect.gen(function* () {
				const written = yield* Effect.flip(
					Harness.commit((tx) => Effect.flatMap(tx.doc(Counter), (counter) => counter.set({ count: 5 }))),
				);
				yield* Harness.commit((tx) =>
					Effect.map(tx.doc(Counter), (counter) => {
						counter.draft.count = "many";
					}),
				);
				const read = yield* Effect.flip(Harness.snapshot(Counter));
				return { written, read };
			}),
		);
		expect(outcome.written._tag).toBe("SchemaDecodeError");
		expect(outcome.read).toMatchObject({ _tag: "SchemaDecodeError", issues: [{ path: "/count" }] });
	});

	it("keeps one document per key of a family, each created from its seed", async () => {
		const outcome = await run(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* root.commit((tx) =>
					Effect.gen(function* () {
						const ana = yield* tx.doc(Notes, root.id, "ana", "Ana");
						yield* ana.update((notes) => ({ ...notes, lines: ["hello"] }));
						yield* tx.doc(Notes, root.id, "bob", "Bob");
					}),
				);
				return {
					ana: Option.getOrThrow(yield* Harness.snapshot(Notes, root.id, "ana")),
					bob: Option.getOrThrow(yield* Harness.snapshot(Notes, root.id, "bob")),
					carl: Option.isNone(yield* Harness.snapshot(Notes, root.id, "carl")),
				};
			}),
		);
		expect(outcome).toEqual({
			ana: { author: "Ana", lines: ["hello"] },
			bob: { author: "Bob", lines: [] },
			carl: true,
		});
	});

	it("retires a document, and a later open creates a new one", async () => {
		const outcome = await run(
			Effect.gen(function* () {
				yield* Harness.commit((tx) => Effect.flatMap(tx.doc(Counter), (counter) => counter.set({ count: 2 })));
				yield* Harness.commit((tx) => tx.retireDoc(Counter));
				const retired = Option.isNone(yield* Harness.snapshot(Counter));
				yield* Harness.commit((tx) => Effect.asVoid(tx.doc(Counter)));
				return { retired, again: Option.getOrThrow(yield* Harness.snapshot(Counter)) };
			}),
		);
		expect(outcome).toEqual({ retired: true, again: { count: 0 } });
	});
});

describe("committed reads", () => {
	it("snapshotAsOf reads the value a rewindable document had at an entry", async () => {
		const outcome = await run(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const write = (items: ReadonlyArray<string>) =>
					root.commit((tx) =>
						Effect.gen(function* () {
							yield* (yield* tx.doc(Todos, root.id)).set({ items, due: new Date(0) });
							return (yield* tx.appendEntry(root.id, { kind: "app.note" })).id;
						}),
					);
				const first = yield* write(["one"]);
				const second = yield* write(["one", "two"]);
				return {
					first: Option.getOrThrow(yield* Harness.snapshotAsOf(Todos, root.id, first)).items,
					second: Option.getOrThrow(yield* Harness.snapshotAsOf(Todos, root.id, second)).items,
				};
			}),
		);
		expect(outcome).toEqual({ first: ["one"], second: ["one", "two"] });
	});

	it("migrates a value stored by an older version when a newer definition reads it", async () => {
		const definition = {
			kind: "app.profile",
			scope: "session",
			checkpointWhen: () => false,
		} as const;
		const V1 = Doc.make({
			...definition,
			version: 1,
			schema: Schema.Struct({ name: Schema.String }),
			initial: () => ({ name: "Ana" }),
		});
		const V2 = Doc.make({
			...definition,
			version: 2,
			schema: Schema.Struct({ names: Schema.Array(Schema.String) }),
			initial: () => ({ names: [] }),
			migrate: (stored, fromVersion) => ({ names: [`${String(stored.name)} (v${fromVersion})`] }),
		});
		const migrated = await run(
			Effect.gen(function* () {
				yield* Harness.commit((tx) => Effect.asVoid(tx.doc(V1)));
				return Option.getOrThrow(yield* Harness.snapshot(V2));
			}),
		);
		expect(migrated).toEqual({ names: ["Ana (v1)"] });
	});

	it("fails the commit with UnexpectedError when `initial` gives a value the schema cannot encode", async () => {
		const Broken = Doc.make({
			kind: "app.broken",
			version: 1,
			scope: "session",
			schema: Schema.Struct({ count: Schema.Number.check(Schema.isLessThan(3)) }),
			initial: () => ({ count: 9 }),
			checkpointWhen: () => false,
		});
		const failure = await run(Effect.flip(Harness.commit((tx) => tx.doc(Broken))));
		expect(failure).toMatchObject({ _tag: "UnexpectedError", cause: { _tag: "SchemaDecodeError" } });
	});

	it("addresses a task document by its task", () => {
		const Progress = Doc.make({
			kind: "app.progress",
			version: 1,
			scope: "task",
			schema: Schema.Struct({ done: Schema.Number }),
			initial: () => ({ done: 0 }),
			checkpointWhen: () => false,
		});
		const address: Equal<Doc.Address<typeof Progress>, [taskId: TaskId]> = true;
		expect(address).toBe(true);
		expect(Progress.scope).toBe("task");
	});
});

describe("watchDoc", () => {
	it("gives the value now and each change, decoded, and releases Pi's watch with its scope", async () => {
		let acquired: WatchHandle<unknown> | undefined;
		const outcome = await runTest(
			Effect.gen(function* () {
				const harness = yield* Harness.Harness;
				yield* Harness.commit((tx) => Effect.asVoid(tx.doc(Counter)));
				// Pi's own watch, kept so the test can ask how it ended.
				const spied = {
					watchDoc: async (...args: Parameters<DocumentObserver["watchDoc"]>) => {
						acquired = await harness.watchDoc(...args);
						return acquired;
					},
				} as unknown as DocumentObserver;
				// Each element the stream gave: a commit made once the one before was taken is an element of its own.
				const taken = yield* Queue.unbounded<unknown>();
				const watching = yield* Effect.forkChild(
					Stream.runCollect(
						Stream.take(
							Stream.tap(Doc.watch(spied, Counter), (change) => Queue.offer(taken, change)),
							3,
						),
					),
				);
				yield* Queue.take(taken);
				yield* Harness.commit((tx) => Effect.flatMap(tx.doc(Counter), (counter) => counter.set({ count: 1 })));
				yield* Queue.take(taken);
				yield* Harness.commit((tx) => Effect.flatMap(tx.doc(Counter), (counter) => counter.set({ count: 2 })));
				const changes = yield* Fiber.join(watching);
				return { changes, end: yield* Effect.promise(() => acquired!.closed) };
			}).pipe(Effect.provide(harnessLayer({}))),
		);
		expect(outcome.changes).toEqual([
			{ value: { count: 0 }, ops: [], retired: false },
			{ value: { count: 1 }, ops: [["s", ["count"], 1]], retired: false },
			{ value: { count: 2 }, ops: [["s", ["count"], 2]], retired: false },
		]);
		expect(outcome.end).toEqual({ kind: "stopped" });
	});

	it("has no element when the address holds no document", async () => {
		const changes = await run(Stream.runCollect(Harness.watchDoc(Counter)));
		expect(changes).toEqual([]);
	});
});

describe("parity with Pi Durable", () => {
	const PiCounter = defineDoc<{ count: number }>({
		kind: "app.counter",
		version: 1,
		scope: "session",
		initial: () => ({ count: 0 }),
		checkpointWhen: () => true,
	});
	const PiNotes = defineDocFamily<{ author: string; lines: string[] }, string>({
		kind: "app.notes",
		version: 1,
		family: true,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: (author) => ({ author, lines: [] }),
		checkpointWhen: () => false,
	});

	it("a session document, a family and a retirement leave the records of Pi's own definitions", async () => {
		const both = await runBoth({
			responses: () => [],
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				yield* Harness.commit((tx) =>
					Effect.gen(function* () {
						yield* (yield* tx.doc(Counter)).set({ count: 2 });
						yield* (yield* tx.doc(Notes, root.id, "ana", "Ana")).update((notes) => ({
							...notes,
							lines: ["hello"],
						}));
						yield* tx.doc(Notes, root.id, "bob", "Bob");
					}),
				);
				yield* Harness.commit((tx) => tx.retireDoc(Notes, root.id, "bob"));
				return {
					counter: Option.getOrUndefined(yield* Harness.snapshot(Counter)),
					ana: Option.getOrUndefined(yield* Harness.snapshot(Notes, root.id, "ana")),
					bob: Option.getOrUndefined(yield* Harness.snapshot(Notes, root.id, "bob")),
				};
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				await harness.commit(async (tx) => {
					(await tx.doc(PiCounter)).count = 2;
					(await tx.doc(PiNotes, root.id, "ana", "Ana")).lines = ["hello"];
					await tx.doc(PiNotes, root.id, "bob", "Bob");
				}, context);
				await harness.commit((tx) => tx.retireDoc(PiNotes, root.id, "bob"), context);
				return {
					counter: await harness.snapshot(PiCounter, context),
					ana: await harness.snapshot(PiNotes, root.id, "ana", context),
					bob: await harness.snapshot(PiNotes, root.id, "bob", context),
				};
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toEqual({ counter: { count: 2 }, ana: { author: "Ana", lines: ["hello"] } });
		const ours = both.effect.records.documents.filter((document) => String(document.record.kind).startsWith("app."));
		expect(ours.map((document) => [document.record.kind, document.record.key, document.value])).toEqual([
			["app.counter", undefined, { count: 2 }],
			["app.notes", "ana", { author: "Ana", lines: ["hello"] }],
		]);
	});
});
