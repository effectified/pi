// OAuth for MCP servers in Effect terms: sign-in in two halves, the loopback callback, the auth provider of HTTP
// connections, discovery and the flow's requests, with the state store given as Effects.

// Every type pi-mcp's OAuth subpath declares (`McpOAuthState`, `McpSignInRedirect`, `OAuthTokens`, ...), so an
// application names them without importing pi-mcp; where this module exports a name of its own, its own wins.
export type * from "@earendil-works/pi-mcp/oauth";
// pi-mcp's pure OAuth helpers, and its OAuth client and memory store: plain objects an application hands to Pi's flow
// (`authorizeMcp`, `adaptOAuthProvider`) as they are.
export {
	buildAuthorizationServerDiscoveryUrls,
	McpOAuthProvider,
	MemoryOAuthStateStore,
	parseWwwAuthenticate,
	resourceUrlFromServerUrl,
	stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
// The OAuth failures, also in the package's root with the rest of the union.
export {
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	McpSignInCancelledError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
} from "../errors.ts";
export { type AuthProviderOptions, adaptOAuthProvider, createMcpAuthProvider } from "./auth-provider.ts";
export { listenForOAuthCallback, waitForOAuthCallback } from "./callback-server.ts";
export {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	selectResource,
} from "./discovery.ts";
export {
	authorizeMcp,
	exchangeAuthorizationCode,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "./flow.ts";
export {
	type LoopbackOptions,
	listenForLoopbackSignIn,
	responseFromRedirectUrl,
	type WaitOptions,
	waitForLoopbackSignIn,
} from "./loopback.ts";
export type { OAuthSettings } from "./settings.ts";
export { type CompleteSignInOptions, completeMcpSignIn, type SignInOptions, startMcpSignIn } from "./sign-in.ts";
export { memoryOAuthStore, type OAuthStore } from "./store.ts";
