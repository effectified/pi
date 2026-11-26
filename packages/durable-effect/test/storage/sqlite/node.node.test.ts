import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Storage } from "../../../src/index.ts";
import { nodeSqlite } from "../../../src/storage/sqlite/node.ts";
import { Benchmark } from "../../../src/testing/index.ts";

const root = mkdtempSync(join(tmpdir(), "durable-effect-sqlite-node-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Node's built-in SQLite (`node:sqlite`): the Node lane only.
describe.skipIf("Bun" in globalThis)("nodeSqlite", () => {
	it("is Pi's SQLite storage in a file, under a prefix, kept across opens", async () => {
		const id = 1 as ConversationId;
		const path = join(root, "pi.sqlite");
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(
				Effect.provide(nodeSqlite(path, { prefix: "pi_" })),
			),
		);
		const found = await Effect.runPromise(
			Storage.HarnessStorage.use((storage) =>
				Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
			).pipe(Effect.provide(nodeSqlite(path, { prefix: "pi_" }))),
		);
		expect(found).toEqual({ id });
	});

	it("fails with UnexpectedError for a prefix SQLite cannot take", async () => {
		const failure = await Effect.runPromise(
			Effect.flip(
				Storage.HarnessStorage.use(Effect.succeed).pipe(
					Effect.provide(nodeSqlite(join(root, "bad.sqlite"), { prefix: "sqlite_x" })),
				),
			),
		);
		expect(failure._tag).toBe("UnexpectedError");
	});
});
