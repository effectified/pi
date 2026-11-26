// pi-ai's tool call validation as Effects that fail with InvalidToolCall.

import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { InvalidToolCall, validateToolArguments, validateToolCall } from "../src/index.ts";
import { runTest } from "../src/testing/index.ts";

const ADD: Tool = {
	name: "add",
	description: "Adds",
	parameters: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
};

const call = (arguments_: ToolCall["arguments"], extra: Partial<ToolCall> = {}): ToolCall => ({
	type: "toolCall",
	id: "call-1",
	name: "add",
	arguments: arguments_,
	...extra,
});

describe("validateToolCall", () => {
	it("gives the coerced arguments of the named tool", async () => {
		expect(await runTest(validateToolCall([ADD], call({ a: "42" })))).toEqual({ a: 42 });
	});

	it("fails with InvalidToolCall for a tool no one declared", async () => {
		const failure = await runTest(Effect.flip(validateToolCall([], call({ a: 1 }))));
		expect(failure).toBeInstanceOf(InvalidToolCall);
		expect(failure).toMatchObject({ toolName: "add", message: 'Tool "add" not found' });
	});
});

describe("validateToolArguments", () => {
	it("fails with pi-ai's message for arguments that do not match", async () => {
		const failure = await runTest(Effect.flip(validateToolArguments(ADD, call({}))));
		expect(failure.message).toContain('Validation failed for tool "add"');
	});

	it("fails for arguments that were malformed JSON", async () => {
		const failure = await runTest(Effect.flip(validateToolArguments(ADD, call({}, { argumentsError: "bad json" }))));
		expect(failure.message).toBe('Invalid arguments for tool "add": bad json');
	});
});
