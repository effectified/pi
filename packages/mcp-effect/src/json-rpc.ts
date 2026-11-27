// JSON-RPC messages as pi-mcp reads them, with the failure to read one typed.

import { type JsonRpcMessage, parseJsonRpcMessage as piParseJsonRpcMessage } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { fromPi, type McpError, type McpFailure } from "./errors.ts";

/** `value` as a JSON-RPC request, notification or response, or an `McpError` (`invalidRequest`) when it is none. */
export const parseJsonRpcMessage: (value: unknown) => Effect.Effect<JsonRpcMessage, McpError> = Effect.fn(
	"McpJsonRpc.parseJsonRpcMessage",
)((value: unknown) =>
	Effect.try({ try: () => piParseJsonRpcMessage(value), catch: fromPi }).pipe(
		// Pi throws nothing here but its `McpError`: anything else is a broken invariant of Pi, not a failure.
		Effect.catchIf(
			(failure: McpFailure): failure is Exclude<McpFailure, McpError> => failure._tag !== "McpError",
			Effect.die,
		),
	),
);
