// Test helper: the testing kit's SQLite storage across a close and a reopen, registered once per driver. The code
// between the "README:" comments is the README's restart example, line for line; the README opens the client itself.

import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Option, Stream } from "effect";
import { Harness } from "../src/index.ts";
import { answer, held, TestHarness } from "../src/testing/index.ts";
import type { ClientLayer, WithDatabaseFile } from "./sqlite-suites.ts";

/** Registers the suite for one driver. */
export function registerKitRestart(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);

	describe(`TestHarness.sqlStorage (${driver})`, () => {
		it("lets a second harness continue what the first left in the same database file", () =>
			withDatabaseFile(async (filename) => {
				const sqlite = client(filename);
				// README: a restart test
				const storage = TestHarness.sqlStorage(sqlite);
				const pending = held(answer("Never given."));
				const first = TestHarness.layerWith({ storage, responses: [pending.response] });
				const second = TestHarness.layerWith({ storage, responses: [answer("Done after the restart.")] });

				const restart = Effect.gen(function* () {
					// The first process: its harness closes while the model still owes the answer.
					const id = yield* Effect.gen(function* () {
						const root = yield* TestHarness.root;
						const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "pending" });
						yield* pending.requested;
						return submission.id;
					}).pipe(Effect.provide(first));
					// The second process: opening the same file resumes the run, and its own model answers it.
					return yield* Effect.gen(function* () {
						const submission = Option.getOrThrow(yield* Harness.submission(id));
						const settled = yield* submission.wait;
						const root = yield* Harness.root;
						const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
						return { settled, kinds: entries.map((entry) => entry.kind) };
					}).pipe(Effect.provide(second));
				});
				// README: end
				const { settled, kinds } = await Effect.runPromise(restart);
				assert.partialDeepEqual(settled, { requestId: "pending", status: "done" });
				assert.deepEqual(kinds, ["pi.user", "pi.assistant"]);
			}));

		it("namespaces Pi's tables with a prefix, and every build on a memory database starts empty", async () => {
			const storage = TestHarness.sqlStorage(client(":memory:"), { prefix: "pi_" });
			const count = Effect.gen(function* () {
				yield* TestHarness.root;
				return (yield* Stream.runCollect(Harness.scanConversations())).length;
			}).pipe(Effect.provide(TestHarness.layer({ storage })));
			assert.deepEqual([await Effect.runPromise(count), await Effect.runPromise(count)], [1, 1]);
		});
	});
}
