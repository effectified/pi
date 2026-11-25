import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Refusal } from "../src/index.ts";

describe("Refusal", () => {
	it("is data with a closed list of rules, and holds no arguments", () => {
		const refusal = { conversationId: 1, taskId: 2, callId: "call-1", tool: "write", rule: "allow-list" };
		expect(Schema.decodeUnknownSync(Refusal.Refusal)(refusal)).toEqual(refusal);
		expect(() => Schema.decodeUnknownSync(Refusal.Refusal)({ ...refusal, rule: "other" })).toThrow();
		expect(Object.keys(Refusal.Refusal.fields).sort()).toEqual(
			["callId", "conversationId", "name", "reason", "rule", "taskId", "tool"].sort(),
		);
	});
});

describe("unavailable", () => {
	it("is the sentence Pi writes for a tool it does not have", () => {
		expect(Refusal.unavailable("write")).toBe("Tool write is not available");
	});
});
