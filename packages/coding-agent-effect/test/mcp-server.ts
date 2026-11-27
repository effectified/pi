// A scripted MCP server for the tests, the other end of `@effectified/pi-mcp`'s in-memory pair: it lists a search
// tool and a failing one and answers their calls. A protocol peer, not a stand-in for any part of Pi.

import { isJsonRpcRequest, LATEST_PROTOCOL_VERSION, McpClient, type McpClientService } from "@effectified/pi-mcp";
import { inMemoryTransportPair } from "@effectified/pi-mcp/testing";
import { Effect, type Scope, Stream } from "effect";

/** The tools the scripted server lists: one with a name only, one whose name the session must sanitize. */
export const TOOLS = [
	{
		name: "search",
		description: "Searches the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		annotations: { readOnlyHint: true, title: "Search" },
	},
	{ name: "fail", inputSchema: { type: "object" } },
];

/** A client of a scripted MCP server on an in-memory pair: it lists `TOOLS` and answers calls of them. */
export const connected: Effect.Effect<McpClientService, unknown, Scope.Scope> = Effect.gen(function* () {
	const pair = yield* inMemoryTransportPair;
	yield* pair.server.messages.pipe(
		Stream.filter(isJsonRpcRequest),
		Stream.runForEach((request) => {
			const params = (request.params ?? {}) as { name?: string; arguments?: { query?: string } };
			const result =
				request.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "docs", version: "1.0.0" },
							instructions: "Search before answering.",
						}
					: request.method === "tools/list"
						? { tools: TOOLS }
						: params.name === "search"
							? {
									content: [{ type: "text", text: `Found: ${params.arguments?.query}` }],
									structuredContent: { hits: 1 },
								}
							: { content: [], isError: true };
			return pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		}),
		Effect.forkScoped,
	);
	return yield* McpClient.connect(pair.client, { name: "test", version: "1.0.0" });
});
