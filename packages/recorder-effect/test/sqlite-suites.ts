// Test helper: the suites that close and reopen a harness on a SQLite file, registered once per driver by a platform
// test file: kill and resume (kill-resume.ts), and a storage copied while its original keeps running.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@gunta/pi-durable-effect";
import { answer, type FauxResponseStep, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, Stream } from "effect";
import { expect, it } from "vitest";
import { fromEntry } from "../src/from-entry.ts";
import { onStorageFork, Recorder, RecordSink, type Records } from "../src/index.ts";
import { type ClientLayer, registerKillResume } from "./kill-resume.ts";
import { ids } from "./support.ts";

/** Vitest's `describe`, or its `skipIf` for the driver the runtime cannot load. */
export type Describe = (name: string, body: () => void) => void;

/** Registers every SQLite suite for one driver. */
export function registerSqliteSuites(describe: Describe, driver: string, client: ClientLayer): void {
	describe(`kill and resume (${driver})`, () => registerKillResume(client, withDatabaseFile));
	describe(`a copied storage (${driver})`, () => registerStorageCopy(client));
}

function registerStorageCopy(client: ClientLayer): void {
	it("delivers what it inherited through its original only, and what it commits itself under its own storage", () =>
		withDatabaseFile(async (filename) => {
			// The product's store: one sink for both storages, so a record is keyed by its storage and its id.
			const store: Array<{ readonly storage: string; readonly record: Records.Record }> = [];
			let holding = false;
			const held = Promise.withResolvers<void>();
			const sinkOf = (storage: string) =>
				Layer.succeed(RecordSink, {
					deliver: (records) =>
						Effect.suspend(() => {
							if (holding) {
								held.resolve();
								return Effect.never;
							}
							store.push(...records.map((record) => ({ storage, record })));
							return Effect.void;
						}),
				});
			const harnessOn = (file: string, responses: ReadonlyArray<FauxResponseStep>, resume: boolean) =>
				TestHarness.layer({
					responses,
					storage: Storage.sql().pipe(Layer.provide(client(file)), Layer.orDie),
					harness: { resume },
				});
			const entriesOf = Effect.flatMap(TestHarness.root, (root) =>
				Stream.runCollect(root.entries({ order: "ascending" })),
			);

			// The original: one turn delivered, a second one committed and not delivered when the copy is made.
			const headAtCopy = await Effect.runPromise(
				Effect.gen(function* () {
					const root = yield* TestHarness.root;
					yield* root.prompt("Say hi.", { requestId: "one" });
					yield* Recorder.flushAll;
					holding = true;
					yield* root.prompt("Say more.", { requestId: "two" });
					yield* Effect.promise(() => held.promise);
					return Option.getOrThrow(yield* root.head);
				}).pipe(
					Effect.provide(Recorder.layer()),
					Effect.provide(harnessOn(filename, [answer("Hi."), answer("More.")], true)),
					Effect.provide(sinkOf("original")),
				),
			);
			holding = false;
			const delivered = store.length;
			const copy = `${filename}.copy`;
			for (const suffix of ["", "-wal", "-shm"]) {
				if (existsSync(filename + suffix)) copyFileSync(filename + suffix, copy + suffix);
			}

			// The copy starts clean, then goes its own way.
			const copied = await Effect.runPromise(
				Effect.gen(function* () {
					yield* onStorageFork;
					return yield* Effect.gen(function* () {
						yield* Recorder.flushAll;
						const inherited = store.length - delivered;
						const root = yield* TestHarness.root;
						yield* root.prompt("Go on.", { requestId: "three" });
						yield* Recorder.flushAll;
						return { inherited, entries: yield* entriesOf };
					}).pipe(Effect.provide(Recorder.layer()));
				}).pipe(Effect.provide(harnessOn(copy, [answer("From the copy.")], false)), Effect.provide(sinkOf("copy"))),
			);

			// The original runs on: its new pump delivers the turn it had left, then a turn of its own.
			const original = await Effect.runPromise(
				Effect.gen(function* () {
					yield* Recorder.flushAll;
					const root = yield* TestHarness.root;
					yield* root.prompt("Go on.", { requestId: "three" });
					yield* Recorder.flushAll;
					return yield* entriesOf;
				}).pipe(
					Effect.provide(Recorder.layer()),
					Effect.provide(harnessOn(filename, [answer("From the original.")], true)),
					Effect.provide(sinkOf("original")),
				),
			);

			const of = (storage: string) => store.filter((kept) => kept.storage === storage).map((kept) => kept.record);
			// Nothing inherited is delivered by the copy: not the delivered turn, not the pending one.
			expect(copied.inherited).toBe(0);
			expect(of("copy")).toEqual(copied.entries.filter((entry) => entry.id > headAtCopy).flatMap(fromEntry));
			expect(of("copy").map((record) => record._tag)).toEqual(["Message", "ModelCall", "Message"]);
			// The original delivered every entry of its own history, the pending turn included, each once.
			expect(of("original")).toEqual(original.flatMap(fromEntry));
			expect(of("original")).toHaveLength(9);
			// Both storages numbered their third turn alike: the same ids name different records, so the storage is
			// part of a record's key.
			const shared = ids(of("copy")).filter((id) => ids(of("original")).includes(id));
			expect(shared).toEqual(ids(of("copy")));
			const text = (records: ReadonlyArray<Records.Record>) =>
				records.flatMap((record) =>
					record._tag === "Message" && record.role === "assistant" ? [record.text] : [],
				);
			expect(text(of("copy"))).toEqual(["From the copy."]);
			expect(text(of("original"))).toEqual(["Hi.", "More.", "From the original."]);
			expect(new Set(store.map((kept) => `${kept.storage}|${kept.record.id}`)).size).toBe(store.length);
		}));
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-recorder-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
