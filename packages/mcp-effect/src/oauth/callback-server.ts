// pi-mcp's OAuth callback server as a scoped resource: a loopback HTTP server the browser redirects to, and the wait
// for one authorization response on it.

import { type OAuthCallback, OAuthCallbackServer, type OAuthCallbackServerOptions } from "@earendil-works/pi-mcp/oauth";
import { Effect, type Scope } from "effect";
import { fromPi, type McpFailure } from "../errors.ts";

/** A callback server listening as `options` say (default: a free port on 127.0.0.1, path `/callback`), for the scope. */
export function listenForOAuthCallback(
	options?: OAuthCallbackServerOptions,
): Effect.Effect<OAuthCallbackServer, McpFailure, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.tryPromise({ try: () => OAuthCallbackServer.listen(options), catch: fromPi }),
		(server) => Effect.promise(() => server.close()),
	);
}

/**
 * The authorization response that carries `state`, on `path` when given. Pi's own timer (the server's `timeoutMs`,
 * five minutes by default) bounds the wait; interrupting it leaves the state pending until then or until the scope
 * closes the server.
 */
export function waitForOAuthCallback(
	server: OAuthCallbackServer,
	state: string,
	path?: string,
): Effect.Effect<OAuthCallback, McpFailure> {
	return Effect.tryPromise({ try: () => server.waitForCallback(state, path), catch: fromPi });
}
