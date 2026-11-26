// JSON-RPC messages read by pi-mcp's parser, with the failure typed.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { JSON_RPC_ERROR_CODES, parseJsonRpcMessage } from "../src/index.ts";

describe("parseJsonRpcMessage", () => {
	it("succeeds with a request, a notification or a response as it is", async () => {
		const request = { jsonrpc: "2.0", id: 1, method: "ping" };
		const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
		const response = { jsonrpc: "2.0", id: 1, result: {} };
		for (const message of [request, notification, response]) {
			expect(await Effect.runPromise(parseJsonRpcMessage(message))).toBe(message);
		}
	});

	it("fails with an McpError of code invalidRequest for anything else", async () => {
		const error = await Effect.runPromise(Effect.flip(parseJsonRpcMessage({ jsonrpc: "1.0", id: 1 })));
		expect(error).toMatchObject({ _tag: "McpError", code: JSON_RPC_ERROR_CODES.invalidRequest });
	});
});
