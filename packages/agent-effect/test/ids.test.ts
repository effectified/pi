import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ToolCallId, ToolName } from "../src/index.ts";

describe("ToolName and ToolCallId", () => {
	it("brand the plain strings Pi gives, and decode them", () => {
		expect(ToolName.make("lookup")).toBe("lookup");
		expect(Schema.decodeUnknownSync(ToolCallId)("call-1")).toBe("call-1");
		expect(() => Schema.decodeUnknownSync(ToolName)(42)).toThrow();
	});

	it("do not mix: a call's id is no tool's name", () => {
		const id = ToolCallId.make("call-1");
		// @ts-expect-error a ToolCallId is not a ToolName
		const name: ToolName = id;
		// @ts-expect-error a plain string is not a ToolName
		const plain: ToolName = "lookup";
		expect([name, plain]).toEqual(["call-1", "lookup"]);
	});
});
