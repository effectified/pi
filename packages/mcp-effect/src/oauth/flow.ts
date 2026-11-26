// pi-mcp's OAuth flow and its single requests in Effect terms: authorization, client registration, the code exchange
// and the refresh, each an Effect that interrupting aborts where Pi takes a signal.

import {
	type OAuthClientInformationFull,
	type OAuthClientProvider,
	type OAuthFlowOptions,
	type OAuthFlowResult,
	type OAuthTokens,
	authorizeMcp as piAuthorizeMcp,
	exchangeAuthorizationCode as piExchangeAuthorizationCode,
	refreshAuthorization as piRefreshAuthorization,
	registerClient as piRegisterClient,
	startAuthorization as piStartAuthorization,
	type TokenRequestOptions,
} from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import { fromPi, type McpFailure } from "../errors.ts";

/**
 * Pi's whole flow for `provider` (an `McpOAuthProvider`, say): refresh the stored tokens, or discover, register and
 * redirect (`REDIRECT`), or exchange `authorizationCode` (`AUTHORIZED`). Interrupting it aborts its requests.
 */
export function authorizeMcp(
	provider: OAuthClientProvider,
	options: Omit<OAuthFlowOptions, "signal">,
): Effect.Effect<OAuthFlowResult, McpFailure> {
	return Effect.tryPromise({ try: (signal) => piAuthorizeMcp(provider, { ...options, signal }), catch: fromPi });
}

/** The authorization URL of a PKCE authorization request, and its code verifier to store. */
export function startAuthorization(
	authorizationServerUrl: string | URL,
	options: Parameters<typeof piStartAuthorization>[1],
): Effect.Effect<Awaited<ReturnType<typeof piStartAuthorization>>, McpFailure> {
	return Effect.tryPromise({ try: () => piStartAuthorization(authorizationServerUrl, options), catch: fromPi });
}

/** Registers a client with the authorization server (dynamic client registration, RFC 7591). */
export function registerClient(
	authorizationServerUrl: string | URL,
	options: Omit<Parameters<typeof piRegisterClient>[1], "signal">,
): Effect.Effect<OAuthClientInformationFull, McpFailure> {
	return Effect.tryPromise({
		try: (signal) => piRegisterClient(authorizationServerUrl, { ...options, signal }),
		catch: fromPi,
	});
}

/** Exchanges an authorization code for tokens. */
export function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: Omit<TokenRequestOptions, "signal"> & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Effect.Effect<OAuthTokens, McpFailure> {
	return Effect.tryPromise({
		try: (signal) => piExchangeAuthorizationCode(authorizationServerUrl, { ...options, signal }),
		catch: fromPi,
	});
}

/** Exchanges a refresh token for new tokens. Many servers rotate the refresh token: save the answer. */
export function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: Omit<TokenRequestOptions, "signal"> & { refreshToken: string },
): Effect.Effect<OAuthTokens, McpFailure> {
	return Effect.tryPromise({
		try: (signal) => piRefreshAuthorization(authorizationServerUrl, { ...options, signal }),
		catch: fromPi,
	});
}
