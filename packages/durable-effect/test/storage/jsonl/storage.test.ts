import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as NodeEnv from "../../../src/env/node.ts";
import { Storage } from "../../../src/index.ts";
import { jsonl } from "../../../src/storage/jsonl/index.ts";
import { Benchmark, storageConformance } from "../../../src/testing/index.ts";

const root = mkdtempSync(join(tmpdir(), "durable-effect-jsonl-"));
let directories = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** JSONL storage in `directory` on Pi's local environment. */
const onDisk = (directory: string, options?: Parameters<typeof jsonl>[2]) =>
	Layer.unwrap(Effect.map(NodeEnv.make({ cwd: root }), (env) => jsonl(directory, env, options)));

describe("Pi's storage conformance on jsonl", () => {
	// A directory of its own for each case.
	const fresh = Layer.suspend(() => onDisk(`conformance-${directories++}`));
	for (const testCase of Effect.runSync(storageConformance(fresh, expect))) {
		it(testCase.name, () => Effect.runPromise(testCase.run));
	}
});

describe("jsonl", () => {
	const id = 1 as ConversationId;

	it("keeps what was committed for the next open, and a read-only open sees it without writing", async () => {
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(Effect.provide(onDisk("kept"))),
		);
		const found = await Effect.runPromise(
			Storage.HarnessStorage.use((storage) =>
				Effect.promise(() => storage.conversation(id, BACKGROUND_CONTEXT)),
			).pipe(Effect.provide(onDisk("kept", { readOnly: true }))),
		);
		expect(found).toEqual({ id });
	});

	it("fails with JsonlCorrupted for a directory recovery cannot repair", async () => {
		const directory = join(root, "corrupt");
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(Effect.provide(onDisk("corrupt"))),
		);
		writeFileSync(join(directory, "main.jsonl"), "not json\n{}\n");
		const failure = await Effect.runPromise(
			Effect.flip(Storage.HarnessStorage.use(Effect.succeed).pipe(Effect.provide(onDisk("corrupt")))),
		);
		expect(failure._tag).toBe("JsonlCorrupted");
	});

	it("fails a commit of a read-only storage with Pi's refusal, writing nothing", async () => {
		await Effect.runPromise(
			Benchmark.commitWrites([{ type: "conversation", value: { id } }]).pipe(Effect.provide(onDisk("refused"))),
		);
		const failure = await Effect.runPromise(
			Effect.flip(
				Benchmark.commitWrites([{ type: "conversation", value: { id: 2 as ConversationId } }]).pipe(
					Effect.provide(onDisk("refused", { readOnly: true })),
				),
			),
		);
		expect([failure._tag, failure.message]).toEqual(["UnexpectedError", "JSONL storage is open read-only"]);
	});
});
