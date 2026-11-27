// pi-mcp in Effect: MCP clients and transports as scoped resources, requests as Effects, notifications as Streams, and
// pi-mcp's errors as one tagged union. OAuth sign-in is in `@effectified/pi-mcp/oauth`, test stand-ins in `/testing`.

// Every type pi-mcp declares (`CallToolResult`, `McpServerConfig`, `StdioTransport`, ...), so an application names
// them without importing pi-mcp; where this package exports a name of its own (`Tool`, `McpFailure`), its own wins.
export type * from "@earendil-works/pi-mcp";
// pi-mcp's own client class, whose name `McpClient` (this package's service) takes, and its tool, which `Tool` brands.
export type { McpClient as PiMcpClient, Tool as PiTool } from "@earendil-works/pi-mcp";
// pi-mcp's pure helpers: configuration checks, tool names and schemas, result content, protocol constants. Synchronous
// and free of I/O.
export {
	createMcpResultSchema,
	createMcpToolName,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isMcpServerOverride,
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	MCP_OUTPUT_MAX_BYTES,
	mcpNamespace,
	mcpServerSummary,
	normalizeMcpInputSchema,
	SUPPORTED_PROTOCOL_VERSIONS,
	toLlmContent,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
export type { Auth } from "./auth.ts";
export { type ClientOptions, McpClient, type McpClientService, type Tool } from "./client.ts";
export {
	McpAbortError,
	McpAuthRequiredError,
	McpConnectionClosedError,
	McpError,
	McpFailure,
	McpHttpError,
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	McpSessionExpiredError,
	McpSignInCancelledError,
	McpTimeoutError,
	McpUnexpectedError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
} from "./errors.ts";
export { parseJsonRpcMessage } from "./json-rpc.ts";
export { limitMcpContent, type ModelContentOptions, type OutputSaver, toMcpModelContent } from "./model-content.ts";
export { McpServerName, McpToolName } from "./names.ts";
export type { RequestOptions } from "./request.ts";
export {
	type Pipe,
	type PipeOptions,
	pipeTransport,
	type StdioOptions,
	type StreamableHttpOptions,
	stdioTransport,
	streamableHttpTransport,
} from "./transports.ts";
