import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { binaryReader, dirEntries, textLines } from "../src/readers.ts";
import { nodeEnv, tempDir } from "./fixtures.ts";

describe("textLines", () => {
	it("streams a file's lines, saying which ended with a newline", async () => {
		const lines = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				writeFileSync(join(directory, "a.txt"), "one\ntwo\nthree");
				return yield* Stream.runCollect(textLines(nodeEnv(directory), "a.txt"));
			}),
		);
		expect(lines).toEqual([
			{ text: "one", terminated: true },
			{ text: "two", terminated: true },
			{ text: "three", terminated: false },
		]);
	});

	it("fails with FileFailed for a missing file", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.exit(Stream.runCollect(textLines(nodeEnv(directory), "gone.txt"))),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "FileFailed", code: "not_found" },
		});
	});
});

describe("binaryReader", () => {
	it("reads ranges and scans lines of the opened file", async () => {
		const read = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				writeFileSync(join(directory, "b.bin"), "abc\ndef\n");
				const reader = yield* binaryReader(nodeEnv(directory), "b.bin");
				return {
					bytes: new TextDecoder().decode(yield* reader.read(4, 3)),
					size: (yield* reader.info).size,
					scan: yield* reader.scanLines({ startLine: 1, endLine: 2 }),
				};
			}),
		);
		expect(read.bytes).toBe("def");
		expect(read.size).toBe(8);
		expect(read.scan).toMatchObject({ newlines: 2, start: 4, end: 7 });
	});

	it("fails with is_directory for a directory", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) => Effect.exit(binaryReader(nodeEnv(directory), "."))),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { code: "is_directory" } });
	});
});

describe("dirEntries", () => {
	it("streams a directory's entries page by page", async () => {
		const names = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(join(directory, name), name);
				mkdirSync(join(directory, "sub"));
				const entries = yield* Stream.runCollect(dirEntries(nodeEnv(directory), ".", 2));
				return entries.map((entry) => `${entry.name}:${entry.kind}`).sort();
			}),
		);
		expect(names).toEqual(["a:file", "b:file", "c:file", "d:file", "e:file", "sub:directory"]);
	});
});
