// JSON-RPC messages as pi-mcp reads them, with the failure to read one typed.

import { type JsonRpcMessage, parseJsonRpcMessage as piParseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { fromPi, type McpError } from "./errors.ts";

/** `value` as a JSON-RPC request, notification or response, or an `McpError` (`invalidRequest`) when it is none. */
export function parseJsonRpcMessage(value: unknown): Effect.Effect<JsonRpcMessage, McpError> {
	return Effect.try({
		try: () => piParseJsonRpcMessage(value),
		// Pi throws nothing here but its `McpError`.
		catch: (cause) => fromPi(cause) as McpError,
	});
}
