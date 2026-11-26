// What this package does with every value pi-mcp exports, in its root, its OAuth subpath and its testing subpath: the
// record of what is offered as it is, what is replaced by an Effect form, and what is still open.

import * as PiMcp from "@earendil-works/pi-mcp";
import * as PiOAuth from "@earendil-works/pi-mcp/oauth";
import * as PiTesting from "@earendil-works/pi-mcp/testing";
import { describe, expect, it } from "vitest";
import type { Coverage } from "../../../effect/conformance.ts";
import * as Package from "../src/index.ts";
import * as OAuth from "../src/oauth/index.ts";
import * as Testing from "../src/testing/index.ts";

const offered: Coverage = { kind: "offered" };
/** Replaced by the export `by` of the same module of this package. */
const replaced = (by: string): Coverage => ({ kind: "replaced", by });

/** pi-mcp's root. */
const COVERAGE = {
	createMcpResultSchema: offered,
	createMcpToolName: offered,
	isJsonRpcNotification: offered,
	isJsonRpcRequest: offered,
	isJsonRpcResponse: offered,
	isMcpServerOverride: offered,
	JSON_RPC_ERROR_CODES: offered,
	LATEST_PROTOCOL_VERSION: offered,
	MCP_OUTPUT_MAX_BYTES: offered,
	mcpNamespace: offered,
	mcpServerSummary: offered,
	normalizeMcpInputSchema: offered,
	SUPPORTED_PROTOCOL_VERSIONS: offered,
	toLlmContent: offered,
	validateMcpServerConfig: offered,
	McpClient: replaced("McpClient"),
	StdioTransport: replaced("stdioTransport"),
	StreamableHttpTransport: replaced("streamableHttpTransport"),
	PipeTransport: replaced("pipeTransport"),
	toMcpModelContent: replaced("toMcpModelContent"),
	limitMcpContent: replaced("limitMcpContent"),
	parseJsonRpcMessage: replaced("parseJsonRpcMessage"),
	McpError: replaced("McpError"),
	McpConnectionClosedError: replaced("McpConnectionClosedError"),
	McpTimeoutError: replaced("McpTimeoutError"),
	McpAbortError: replaced("McpAbortError"),
	McpHttpError: replaced("McpHttpError"),
	McpAuthRequiredError: replaced("McpAuthRequiredError"),
	McpSessionExpiredError: replaced("McpSessionExpiredError"),
} satisfies Record<keyof typeof PiMcp, Coverage>;

/** pi-mcp's OAuth subpath. */
const OAUTH_COVERAGE = {
	buildAuthorizationServerDiscoveryUrls: offered,
	parseWwwAuthenticate: offered,
	resourceUrlFromServerUrl: offered,
	stepUpScope: offered,
	McpOAuthProvider: offered,
	MemoryOAuthStateStore: offered,
	startMcpSignIn: replaced("startMcpSignIn"),
	completeMcpSignIn: replaced("completeMcpSignIn"),
	listenForLoopbackSignIn: replaced("listenForLoopbackSignIn"),
	waitForLoopbackSignIn: replaced("waitForLoopbackSignIn"),
	responseFromRedirectUrl: replaced("responseFromRedirectUrl"),
	OAuthCallbackServer: replaced("listenForOAuthCallback"),
	createMcpAuthProvider: replaced("createMcpAuthProvider"),
	adaptOAuthProvider: replaced("adaptOAuthProvider"),
	discoverProtectedResourceMetadata: replaced("discoverProtectedResourceMetadata"),
	discoverAuthorizationServerMetadata: replaced("discoverAuthorizationServerMetadata"),
	discoverOAuthServerInfo: replaced("discoverOAuthServerInfo"),
	selectResource: replaced("selectResource"),
	authorizeMcp: replaced("authorizeMcp"),
	startAuthorization: replaced("startAuthorization"),
	registerClient: replaced("registerClient"),
	exchangeAuthorizationCode: replaced("exchangeAuthorizationCode"),
	refreshAuthorization: replaced("refreshAuthorization"),
	OAuthError: replaced("OAuthError"),
	OAuthIssuerMismatchError: replaced("OAuthIssuerMismatchError"),
	OAuthInsecureEndpointError: replaced("OAuthInsecureEndpointError"),
	OAuthRegistrationError: replaced("OAuthRegistrationError"),
	McpOAuthAuthorizationRequiredError: replaced("McpOAuthAuthorizationRequiredError"),
	McpRefreshLockBusyError: replaced("McpRefreshLockBusyError"),
	McpSignInCancelledError: replaced("McpSignInCancelledError"),
} satisfies Record<keyof typeof PiOAuth, Coverage>;

/** pi-mcp's testing subpath. */
const TESTING_COVERAGE = {
	createInMemoryTransportPair: replaced("inMemoryTransportPair"),
	InMemoryTransport: replaced("inMemoryTransportPair"),
} satisfies Record<keyof typeof PiTesting, Coverage>;

const LEDGERS = [
	["pi-mcp", COVERAGE, PiMcp, Package],
	["pi-mcp/oauth", OAUTH_COVERAGE, PiOAuth, OAuth],
	["pi-mcp/testing", TESTING_COVERAGE, PiTesting, Testing],
] as const;

describe.each(LEDGERS)("the coverage of %s", (_name, coverage, pi, ours) => {
	const entries: ReadonlyArray<readonly [string, Coverage]> = Object.entries(coverage);

	it("offers Pi's own value for every entry it records as offered", () => {
		const exported: Record<string, unknown> = ours;
		const piValues: Record<string, unknown> = pi;
		const wrong = entries
			.filter(([name, entry]) => entry.kind === "offered" && exported[name] !== piValues[name])
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});

	it("exports the Effect form every replaced entry names", () => {
		const names = new Set(Object.keys(ours));
		const missing = entries.flatMap(([name, entry]) =>
			entry.kind === "replaced" && !names.has(entry.by) ? [`${name}: ${entry.by}`] : [],
		);
		expect(missing).toEqual([]);
	});

	it("leaves nothing open", () => {
		expect(entries.filter(([, entry]) => entry.kind === "open")).toEqual([]);
	});
});
