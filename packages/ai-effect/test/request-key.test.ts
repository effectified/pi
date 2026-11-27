// The key of a request: equal for what asks the same, different for anything else, whatever order built it.

import type { Context as PiContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { requestKey } from "../src/index.ts";

const context = (text: string): PiContext => ({
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: text, timestamp: 1 }],
});

const keyOf = (session: string, asked: PiContext): Promise<string> => Effect.runPromise(requestKey(session, asked));

describe("requestKey", () => {
	it("is 64 hexadecimal digits, the same whenever the same session asks the same", async () => {
		const first = await keyOf("s1", context("What is six times seven?"));
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await keyOf("s1", context("What is six times seven?"))).toBe(first);
	});

	it("is another for another session, and for a context that asks anything else", async () => {
		const first = await keyOf("s1", context("What is six times seven?"));
		expect(await keyOf("s2", context("What is six times seven?"))).not.toBe(first);
		expect(await keyOf("s1", context("What is six times eight?"))).not.toBe(first);
		expect(await keyOf("s1", { ...context("What is six times seven?"), systemPrompt: "Answer at length." })).not.toBe(
			first,
		);
	});

	it("does not depend on the order an object was built in, nor on a property that is undefined", async () => {
		const built: PiContext = {
			messages: [{ timestamp: 1, content: "What is six times seven?", role: "user" }],
			systemPrompt: "Answer briefly.",
			tools: undefined,
		};
		expect(await keyOf("s1", built)).toBe(await keyOf("s1", context("What is six times seven?")));
	});

	it("stays the key earlier versions gave, so a request in flight across an upgrade keeps its key", async () => {
		// Escapes, integer-like keys (which a JSON object would put first) and every kind of JSON value. Only the JSON
		// of the context is hashed, so an assistant message without its usage and stop reason will do.
		const asked = {
			systemPrompt: 'Say "hi" — ünïcode, \n and \\ too',
			messages: [
				{ role: "user", content: "What is six times seven?", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "c1",
							name: "calc",
							arguments: { 10: "ten", 9: "nine", b: [1, 2.5, null, true] },
						},
					],
					timestamp: 2,
				},
			],
			tools: [
				{ name: "calc", description: "", parameters: { type: "object", properties: { x: { type: "number" } } } },
			],
		} as unknown as PiContext;
		// What version 0.2.0 computed, with `JSON.stringify` for each key and primitive.
		expect(await keyOf("s1", asked)).toBe("da75fc2ee220d35749fb33a52e19421405116b0408a5329d6169bb755fa17143");
	});
});
