// The auth of connections to an OAuth-protected MCP server in Effect terms: Pi's auth provider, which sends the
// stored access token and refreshes it, as an `Auth` for the HTTP transport, waited for when its scope closes.

import {
	type McpOAuthSettings,
	type OAuthChallenge,
	type OAuthClientProvider,
	adaptOAuthProvider as piAdaptOAuthProvider,
	createMcpAuthProvider as piCreateMcpAuthProvider,
} from "@earendil-works/pi-mcp/oauth";
import { Effect, Queue, type Scope } from "effect";
import { type Auth, fromAuthProvider } from "../auth.ts";
import type { McpFailure } from "../errors.ts";
import { currentRunner, currentSyncRunner } from "../run-in-pi.ts";
import { type OAuthStore, toPiStore } from "./store.ts";

/** Pi's options of `createMcpAuthProvider`, with an `OAuthStore`, the settings as an Effect and challenges to a queue. */
export interface AuthProviderOptions<R = never>
	extends Omit<Parameters<typeof piCreateMcpAuthProvider>[0], "store" | "settings" | "onChallenge"> {
	readonly store: OAuthStore<R>;
	/**
	 * The client settings, read only when a refresh needs them, so a secret that fails to resolve fails the refresh and
	 * not the connection. Pi reads them synchronously: the Effect must not wait.
	 */
	readonly settings: Effect.Effect<McpOAuthSettings, McpFailure, R>;
	/** Each `WWW-Authenticate` challenge of the server, so a sign-in can use its resource metadata URL and scope. */
	readonly challenges?: Queue.Enqueue<OAuthChallenge>;
}

/**
 * Pi's auth provider for connections to an OAuth-protected server, as an `Auth`: it sends the stored access token
 * and refreshes it before it expires or after a 401, and fails with `McpOAuthAuthorizationRequiredError` when the
 * user has to sign in. Closing the scope waits for a refresh in flight, so rotated tokens are saved.
 */
export function createMcpAuthProvider<R = never>(
	options: AuthProviderOptions<R>,
): Effect.Effect<Auth, never, Scope.Scope | R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const runSync = yield* currentSyncRunner<R>();
		const { store, settings, challenges, ...rest } = options;
		const provider = yield* Effect.acquireRelease(
			Effect.sync(() =>
				piCreateMcpAuthProvider({
					...rest,
					store: toPiStore(store, run),
					settings: () => runSync(settings),
					onChallenge: (challenge) => {
						if (challenges !== undefined) Queue.offerUnsafe(challenges, challenge);
					},
				}),
			),
			(provider) => Effect.promise(() => provider.settled()),
		);
		return fromAuthProvider(provider);
	});
}

/**
 * An `Auth` from Pi's OAuth client `provider` (an `McpOAuthProvider`, say): its stored access token, and after a 401
 * one shared refresh or Pi's whole flow, which reaches `redirectToAuthorization` when the user has to sign in.
 */
export function adaptOAuthProvider(provider: OAuthClientProvider): Effect.Effect<Auth> {
	return Effect.sync(() => fromAuthProvider(piAdaptOAuthProvider(provider)));
}
