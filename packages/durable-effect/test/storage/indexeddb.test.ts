import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect, Layer } from "effect";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Storage } from "../../src/index.ts";
import { indexedDb } from "../../src/storage/indexeddb.ts";
import { Benchmark, storageConformance } from "../../src/testing/index.ts";

// IndexedDB in memory (`fake-indexeddb`, as Pi Durable's own tests use): Node and Bun have no IndexedDB of their own.
// Pi reads key ranges from the global, as a browser has it; the factory is given to each storage.
Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange });

let databases = 0;

describe("Pi's storage conformance on indexedDb", () => {
	// A database of its own for each case.
	const fresh = Layer.suspend(() => indexedDb(`conformance-${databases++}`, { indexedDB: new IDBFactory() }));
	for (const testCase of Effect.runSync(storageConformance(fresh, expect))) {
		it(testCase.name, () => Effect.runPromise(testCase.run));
	}
});

describe("indexedDb", () => {
	it("keeps what was committed for the next open of the same database", async () => {
		const layer = indexedDb("kept", { indexedDB: new IDBFactory() });
		const id = 1 as ConversationId;
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(Effect.provide(layer)),
		);
		const found = await Effect.runPromise(
			Storage.HarnessStorage.use((storage) =>
				Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
			).pipe(Effect.provide(layer)),
		);
		expect(found).toEqual({ id });
	});

	it("fails with UnexpectedError where IndexedDB is not available", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(Storage.HarnessStorage.use(Effect.succeed).pipe(Effect.provide(indexedDb("none")))),
		);
		expect([failure._tag, failure.message]).toEqual(["UnexpectedError", "IndexedDB is not available"]);
	});
});
