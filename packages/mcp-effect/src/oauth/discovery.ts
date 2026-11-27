// OAuth discovery of an MCP server in Effect terms: its protected resource metadata, its authorization server's
// metadata, and the resource a token is for. Interrupting a discovery aborts its requests.

import {
	type OAuthProtectedResourceMetadata,
	discoverAuthorizationServerMetadata as piDiscoverAuthorizationServerMetadata,
	discoverOAuthServerInfo as piDiscoverOAuthServerInfo,
	discoverProtectedResourceMetadata as piDiscoverProtectedResourceMetadata,
	selectResource as piSelectResource,
} from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import { fromPi } from "../errors.ts";

/** The options of a Pi function `F` without its abort signal, which the fiber owns. */
type Options<F extends (...args: never[]) => unknown> = Omit<NonNullable<Parameters<F>[1]>, "signal">;

/** The protected resource metadata of the MCP server at `serverUrl` (RFC 9728), as Pi discovers it. */
export const discoverProtectedResourceMetadata = Effect.fn("McpOAuth.discoverProtectedResourceMetadata")(
	(serverUrl: string | URL, options?: Options<typeof piDiscoverProtectedResourceMetadata>) =>
		Effect.tryPromise({
			try: (signal) => piDiscoverProtectedResourceMetadata(serverUrl, { ...options, signal }),
			catch: fromPi,
		}),
);

/** The metadata of the authorization server at `authorizationServerUrl` (RFC 8414 or OpenID), or none. */
export const discoverAuthorizationServerMetadata = Effect.fn("McpOAuth.discoverAuthorizationServerMetadata")(
	(authorizationServerUrl: string | URL, options?: Options<typeof piDiscoverAuthorizationServerMetadata>) =>
		Effect.tryPromise({
			try: (signal) => piDiscoverAuthorizationServerMetadata(authorizationServerUrl, { ...options, signal }),
			catch: fromPi,
		}),
);

/** The MCP server's resource metadata, its authorization server and that server's metadata, as Pi discovers them. */
export const discoverOAuthServerInfo = Effect.fn("McpOAuth.discoverOAuthServerInfo")(
	(serverUrl: string | URL, options?: Options<typeof piDiscoverOAuthServerInfo>) =>
		Effect.tryPromise({
			try: (signal) => piDiscoverOAuthServerInfo(serverUrl, { ...options, signal }),
			catch: fromPi,
		}),
);

/** The resource a token for `serverUrl` is requested for; fails when `metadata` names a resource that does not cover it. */
export const selectResource = Effect.fn("McpOAuth.selectResource")(
	(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata) =>
		Effect.try({ try: () => piSelectResource(serverUrl, metadata), catch: fromPi }),
);
