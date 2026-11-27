// The names around an MCP connection that must not mix: a server's own name of one of its tools, and the name an
// application gives a server.

import { Schema } from "effect";

/**
 * The name a server gives one of its tools: what `tools/list` lists and `tools/call` takes. Not the name Pi gives the
 * tool in a session (`createMcpToolName`), which carries the server's name too.
 */
export const McpToolName = Schema.String.pipe(Schema.brand("McpToolName"));

/** The name a server gives one of its tools. */
export type McpToolName = typeof McpToolName.Type;

/**
 * The name an application gives an MCP server, as its configuration names it: what Pi's tool names
 * (`mcp__<server>__<tool>`), namespaces and messages to the model carry.
 */
export const McpServerName = Schema.String.pipe(Schema.brand("McpServerName"));

/** The name an application gives an MCP server. */
export type McpServerName = typeof McpServerName.Type;
