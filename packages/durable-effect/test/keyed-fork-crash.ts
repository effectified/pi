// Test helper: the keyed fork (keyed-fork.ts) across a crash on a SQLite file, registered once per driver. A job forks
// a conversation with its key written in `init`, and the process dies before the job recorded the fork anywhere else:
// a copy of the database file taken right after the fork is what such a process leaves. A harness on the copy finds
// the fork again by the key, and a retried job makes no second one.

import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Layer, Option } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Harness, Storage } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";
import { AlreadyForked, conversations, findByKey, findByScan, forkFor } from "./keyed-fork.ts";
import type { ClientLayer, CopyDatabaseFile, WithDatabaseFile } from "./sqlite-suites.ts";

/** Registers the suite for one driver. */
export function registerKeyedForkCrash(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
	copyDatabaseFile: CopyDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);
	const on = (database: Layer.Layer<SqlClient, SqlError>) =>
		TestHarness.layer({ storage: Storage.sql().pipe(Layer.provide(database), Layer.orDie) });

	describe(`a fork keyed in init, across a crash (${driver})`, () => {
		it("is found again by its key after the crash, and a retried job makes no second copy", () =>
			withDatabaseFile(async (filename) => {
				const crashed = `${filename}.crashed`;
				const forked = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						yield* root.commit((tx) => tx.appendEntry(root.id, { kind: "test.primed" }));
						// The process dies before the fork: the key is not there, and neither is a fork.
						copyDatabaseFile(filename, `${filename}.before`);
						const fork = yield* forkFor(root, "job-1");
						// The process dies right after the creating commit: nothing but the storage knows the fork.
						copyDatabaseFile(filename, crashed);
						return fork.id;
					}).pipe(Effect.provide(on(client(filename)))),
				);
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						return { byKey: Option.isNone(yield* findByKey("job-1")), stored: (yield* conversations).length };
					}).pipe(Effect.provide(on(client(`${filename}.before`)))),
				);
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						const byKey = Option.getOrThrow(yield* findByKey("job-1"));
						const found = yield* Harness.conversation(byKey);
						const retried = yield* Effect.flip(forkFor(root, "job-1"));
						return {
							byKey,
							exists: Option.isSome(found),
							byScan: yield* findByScan("job-1"),
							retried,
							stored: (yield* conversations).map((conversation) => conversation.id),
						};
					}).pipe(Effect.provide(on(client(crashed)))),
				);
				assert.deepEqual(before, { byKey: true, stored: 1 });
				assert.strictEqual(after.byKey, forked);
				assert.strictEqual(after.exists, true);
				assert.deepEqual(after.byScan, [forked]);
				assert.deepEqual(after.retried, new AlreadyForked({ key: "job-1", conversationId: forked }));
				// The root and the one fork: the retry stored nothing.
				assert.strictEqual(after.stored.length, 2);
				assert.strictEqual(after.stored[1], forked);
			}));
	});
}
