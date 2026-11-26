import { createHost, defineFacet, defineState, local, method, obj, str } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { Effect, Exit, Fiber, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Store, sqliteBackend } from "../src/index.ts";
import { run } from "./run.ts";

// A persisted document Chord's own host commits to the store: what `Store.committed` and archives see.
const Note = defineState("note", {
	schema: obj({ body: str() }),
	version: 1,
	initial: () => ({ body: "" }),
	persist: true,
	checkpointWhen: () => false,
});
const Notebook = local("example.notebook", { version: 1, params: {}, members: { write: method(str()) } });
const notebook = defineFacet((host) => {
	host.serve(Notebook, (_, self) => {
		const note = self.state(Note);
		return {
			write: async (body, ctx) => {
				await self.tx(async (tx) => {
					(await tx.draft(note)).body = body;
				}, ctx);
				return null;
			},
		};
	});
});

/** Writes `bodies` to the note through Chord's host on `store`, one commit each. */
function write(store: Store.Store, bodies: readonly string[]): Effect.Effect<void> {
	return Effect.promise(async () => {
		const context = BACKGROUND_CONTEXT;
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@example/notebook", facet: notebook }], context);
		const reference = await host.get(Notebook, {}, context);
		for (const body of bodies) await reference.write(body, context);
		await host.close(context);
	});
}

/** A backend on a fresh SQLite database in memory; the store that opens on it owns and closes it. */
const memoryBackend = Effect.map(
	Effect.promise(() => openNodeSqliteDatabase(":memory:")),
	(database) => sqliteBackend(database),
);

class Unreadable extends Schema.TaggedError<Unreadable>()("Unreadable", {}) {}

describe("Store.open", () => {
	it("opens a store for the scope, at seq 0, and closes it with the scope", async () => {
		const closed = await run(
			Effect.gen(function* () {
				const store = yield* Effect.scoped(
					Effect.gen(function* () {
						const store = yield* Store.open(yield* memoryBackend);
						expect(yield* Store.lastSeq(store)).toBe(0);
						expect(store.outbox).toBeUndefined();
						return store;
					}),
				);
				return yield* Effect.exit(Stream.runCollect(Store.archive(store)));
			}),
		);
		expect(closed).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "released" }));
	});

	it("turns the outbox on when asked", async () => {
		const outbox = await run(
			Effect.map(
				Effect.flatMap(memoryBackend, (backend) => Store.open(backend, { outbox: true })),
				(store) => store.outbox !== undefined,
			),
		);
		expect(outbox).toBe(true);
	});
});

describe("Store.committed", () => {
	it("gives the store's lastSeq after each publication of commits, from the next one on", async () => {
		const [seqs, last] = await run(
			Effect.gen(function* () {
				const store = yield* Store.open(yield* memoryBackend);
				const watching = yield* Effect.forkChild(Stream.runCollect(Stream.take(Store.committed(store), 2)), {
					startImmediately: true,
				});
				yield* write(store, ["one", "two"]);
				return [yield* Fiber.join(watching), yield* Store.lastSeq(store)] as const;
			}),
		);
		expect(seqs).toHaveLength(2);
		expect(seqs.at(-1)).toBe(last);
		expect(last).toBeGreaterThan(0);
	});
});

describe("Store.archive and Store.importArchive", () => {
	it("carries a store's commits into the store it imports", async () => {
		const [exported, imported] = await run(
			Effect.gen(function* () {
				const store = yield* Store.open(yield* memoryBackend);
				yield* write(store, ["kept"]);
				const copy = yield* Store.importArchive(yield* memoryBackend, Store.archive(store));
				return [yield* Store.lastSeq(store), yield* Store.lastSeq(copy)] as const;
			}),
		);
		expect(imported).toBe(exported);
	});

	it("exports a store as archive parts and imports them into another backend", async () => {
		const [parts, imported] = await run(
			Effect.gen(function* () {
				const store = yield* Store.open(yield* memoryBackend);
				const parts = yield* Stream.runCollect(Store.archive(store));
				const copy = yield* Store.importArchive(yield* memoryBackend, Stream.fromIterable(parts));
				return [parts, yield* Store.lastSeq(copy)] as const;
			}),
		);
		expect(parts.map((part) => part.kind)).toEqual(["manifest", "end"]);
		expect(imported).toBe(0);
	});

	it("round-trips an archive through JSONL bytes", async () => {
		const decoded = await run(
			Effect.gen(function* () {
				const store = yield* Store.open(yield* memoryBackend);
				const bytes = Store.encodeJsonl(Store.archive(store));
				const parts = yield* Stream.runCollect(Store.decodeJsonl(bytes));
				yield* Store.importArchive(yield* memoryBackend, Stream.fromIterable(parts));
				return parts;
			}),
		);
		expect(decoded).toHaveLength(2);
	});

	it("refuses an archive that is not one, as Chord's invalid/args", async () => {
		const exit = await run(
			Effect.exit(
				Effect.flatMap(memoryBackend, (backend) => Store.importArchive(backend, Stream.make({ kind: "nonsense" }))),
			),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});

	it("fails with the failure of the parts it reads", async () => {
		const exit = await run(
			Effect.exit(
				Effect.flatMap(memoryBackend, (backend) => Store.importArchive(backend, Stream.fail(new Unreadable()))),
			),
		);
		expect(exit).toEqual(Exit.fail(new Unreadable()));
	});

	it("refuses a backend that holds a store already", async () => {
		const exit = await run(
			Effect.gen(function* () {
				const backend = yield* memoryBackend;
				const store = yield* Store.open(backend);
				const parts = yield* Stream.runCollect(Store.archive(store));
				return yield* Effect.exit(Store.importArchive(backend, Stream.fromIterable(parts)));
			}),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});
});

describe("Store.decodeJsonl", () => {
	it("fails a line that is no JSON as Chord's invalid/args", async () => {
		const exit = await run(
			Effect.exit(Stream.runCollect(Store.decodeJsonl(Stream.make(new TextEncoder().encode("{}\nnot json\n"))))),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});
});

describe("Store.readHostArchive", () => {
	it("refuses an archive without a host as Chord's invalid/args", async () => {
		const exit = await run(
			Effect.exit(
				Effect.gen(function* () {
					const store = yield* Store.open(yield* memoryBackend);
					return yield* Store.readHostArchive(Store.archive(store));
				}),
			),
		);
		expect(exit).toMatchObject(Exit.fail({ _tag: "ChordFailed", code: "invalid", reason: "args" }));
	});
});
