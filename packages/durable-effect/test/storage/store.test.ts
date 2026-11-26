import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Store, sqliteBackend } from "@effectified/pi-chord";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Storage } from "../../src/index.ts";
import { store } from "../../src/storage/store.ts";
import { Benchmark, storageConformance } from "../../src/testing/index.ts";

/** A Chord store on a fresh SQLite database in memory, open for the scope. */
const memoryStore = Effect.flatMap(
	Effect.promise(() => openNodeSqliteDatabase(":memory:")),
	(database) => Store.open(sqliteBackend(database)),
);

describe("store", () => {
	it("is Pi's storage in a Chord store: its commits are the store's", async () => {
		const id = 1 as ConversationId;
		const [before, after, found] = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const chord = yield* memoryStore;
					const before = yield* Store.lastSeq(chord);
					yield* Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(
						Effect.provide(store(chord, "pi")),
					);
					// The storage's scope closed and released its claim; the store stays open, so a new claim reads it.
					const found = yield* Storage.HarnessStorage.use((storage) =>
						Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
					).pipe(Effect.provide(store(chord, "pi")));
					return [before, yield* Store.lastSeq(chord), found] as const;
				}),
			),
		);
		expect(after).toBeGreaterThan(before);
		expect(found).toEqual({ id });
	});

	it("fails with UnexpectedError for an owner claimed twice in one store", async () => {
		const failure = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const chord = yield* memoryStore;
					yield* Layer.build(store(chord, "pi"));
					return yield* Effect.flip(Layer.build(store(chord, "pi")));
				}),
			),
		);
		expect(failure._tag).toBe("UnexpectedError");
	});

	it("keeps harnesses of distinct owners apart in one store", async () => {
		const id = 1 as ConversationId;
		const other = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const chord = yield* memoryStore;
					yield* Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(
						Effect.provide(store(chord, "first")),
					);
					return yield* Storage.HarnessStorage.use((storage) =>
						Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
					).pipe(Effect.provide(store(chord, "second")));
				}),
			),
		);
		expect(other).toBeUndefined();
	});
});

describe("Pi's storage conformance on a Chord store", () => {
	const layer = Layer.unwrap(Effect.map(memoryStore, (chord) => store(chord, "pi")));
	for (const testCase of Effect.runSync(storageConformance(layer, expect))) {
		it(testCase.name, () => Effect.runPromise(testCase.run));
	}
});
