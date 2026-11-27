// The names around an MCP connection that must not mix, as branded Schemas.

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { McpServerName, McpToolName } from "../src/index.ts";

describe("McpToolName and McpServerName", () => {
	it("are the string they are made of, decoded or made", async () => {
		expect(McpToolName.make("echo")).toBe("echo");
		expect(await Effect.runPromise(Schema.decodeUnknownEffect(McpServerName)("files"))).toBe("files");
	});

	it("do not stand in for each other, nor take a plain string", () => {
		const tool = McpToolName.make("echo");
		// @ts-expect-error A tool's name is not a server's.
		const server: McpServerName = tool;
		// @ts-expect-error A plain string is not a tool's name.
		const plain: McpToolName = "echo";
		expect([server, plain]).toEqual(["echo", "echo"]);
	});
});
