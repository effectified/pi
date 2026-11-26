import { LineScanner, StreamDecoder } from "@earendil-works/pi-durable/env";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { decodeRange, decodeText, scanLines } from "../../src/env/index.ts";

const encoder = new TextEncoder();

/** `text` as UTF-8 cut into chunks of `size` bytes, so characters are split across chunks. */
function chunked(text: string, size: number): Uint8Array[] {
	const bytes = encoder.encode(text);
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
	return chunks;
}

const TEXT = "﻿grüße\nline two ✓\n\nlast";

describe("decodeText", () => {
	it("gives what Pi's StreamDecoder gives, a split character and the byte-order mark included", async () => {
		const chunks = chunked(TEXT, 3);
		const decoder = new StreamDecoder();
		const pi = [...chunks.map((chunk) => decoder.decode(chunk)), decoder.decode()].join("");
		const ours = await Effect.runPromise(Stream.mkString(decodeText(Stream.fromIterable(chunks))));
		expect(ours).toBe(pi);
		expect(ours).toBe(TEXT.slice(1));
	});
});

describe("decodeRange", () => {
	it("keeps a leading U+FEFF, since a range has no byte-order mark", async () => {
		const ours = await Effect.runPromise(Stream.mkString(decodeRange(Stream.fromIterable(chunked(TEXT, 2)))));
		expect(ours).toBe(TEXT);
	});
});

describe("scanLines", () => {
	it("finds the lines of a range as Pi's LineScanner does", async () => {
		const chunks = chunked(TEXT, 4);
		const scanner = new LineScanner(1, 3);
		for (const chunk of chunks) scanner.push(chunk);
		const ours = await Effect.runPromise(scanLines(Stream.fromIterable(chunks), { startLine: 1, endLine: 3 }));
		expect(ours).toEqual(scanner.finish());
		expect(ours.newlines).toBe(3);
	});

	it("fails with UnexpectedError for a range Pi refuses", async () => {
		const failure = await Effect.runPromise(Effect.flip(scanLines(Stream.empty, { startLine: 2, endLine: 1 })));
		expect([failure._tag, failure.message]).toEqual(["UnexpectedError", "Invalid line range"]);
	});
});
