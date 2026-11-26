import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Storage } from "../../../src/index.ts";
import { nodeJsonl } from "../../../src/storage/jsonl/node.ts";
import { Benchmark } from "../../../src/testing/index.ts";

const root = mkdtempSync(join(tmpdir(), "durable-effect-jsonl-node-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("nodeJsonl", () => {
	it("is Pi's JSONL storage in a directory of the local file system, kept across opens", async () => {
		const id = 1 as ConversationId;
		const directory = join(root, "store");
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(Effect.provide(nodeJsonl(directory))),
		);
		const found = await Effect.runPromise(
			Storage.HarnessStorage.use((storage) =>
				Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
			).pipe(Effect.provide(nodeJsonl(directory))),
		);
		expect(found).toEqual({ id });
	});
});
