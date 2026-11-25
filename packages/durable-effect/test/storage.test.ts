import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Storage } from "../src/index.ts";
import { KeptStorage } from "./scripted.ts";

const context = BACKGROUND_CONTEXT;

/** The storage of a Layer, taken out of its scope: the scope has closed when this resolves. */
const storageOf = Storage.HarnessStorage.use((storage) => Effect.succeed(storage));

describe("memory", () => {
	it("is usable inside the scope and closed after it", async () => {
		const storage = await Effect.runPromise(
			Storage.HarnessStorage.use((opened) =>
				Effect.as(
					Effect.promise(() => opened.conversation(ROOT_CONVERSATION_ID, context)),
					opened,
				),
			).pipe(Effect.provide(Storage.memory)),
		);
		await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("MemoryStorage is closed");
	});

	it("is a fresh storage for each build of the Layer", async () => {
		const first = await Effect.runPromise(storageOf.pipe(Effect.provide(Storage.memory)));
		const second = await Effect.runPromise(storageOf.pipe(Effect.provide(Storage.memory)));
		expect(first).not.toBe(second);
	});
});

describe("custom", () => {
	it("closes a storage nothing else closed, once, when the scope closes", async () => {
		const kept = new KeptStorage();
		const closesInside = await Effect.runPromise(
			Storage.HarnessStorage.use(() => Effect.sync(() => kept.closes)).pipe(Effect.provide(Storage.custom(kept))),
		);
		expect(closesInside).toBe(0);
		expect(kept.closes).toBe(1);
	});

	it("closes the storage once when its user closed it before the scope does, as a harness does", async () => {
		const kept = new KeptStorage();
		await Effect.runPromise(
			Storage.HarnessStorage.use((storage) =>
				Effect.promise(async () => {
					await storage.close(context);
					await storage.close(context);
				}),
			).pipe(Effect.provide(Storage.custom(kept))),
		);
		expect(kept.closes).toBe(1);
	});

	it("opens the storage with an Effect, and fails the Layer with its error", async () => {
		const kept = new KeptStorage();
		const opened = await Effect.runPromise(storageOf.pipe(Effect.provide(Storage.custom(Effect.sync(() => kept)))));
		expect(await opened.mintId()).toBe(await kept.mintId().then((next) => next - 1));
		const error = await Effect.runPromise(
			Effect.flip(storageOf.pipe(Effect.provide(Storage.custom(Effect.fail("no disk" as const))))),
		);
		expect(error).toBe("no disk");
	});

	it("passes a storage's optional publishing scope on, and adds none", async () => {
		const published: string[] = [];
		class Publishing extends MemoryStorage {
			publishing(publish: () => void): void {
				published.push("publishing");
				publish();
			}
		}
		const withScope = await Effect.runPromise(storageOf.pipe(Effect.provide(Storage.custom(new Publishing()))));
		withScope.publishing?.(() => published.push("published"), context);
		expect(published).toEqual(["publishing", "published"]);
		const without = await Effect.runPromise(storageOf.pipe(Effect.provide(Storage.custom(new MemoryStorage()))));
		expect(without.publishing).toBeUndefined();
	});
});
