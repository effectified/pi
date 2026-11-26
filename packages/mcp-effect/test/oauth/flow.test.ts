// pi-mcp's OAuth flow and its single requests as Effects, against a local authorization server.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	authorizeMcp,
	discoverAuthorizationServerMetadata,
	exchangeAuthorizationCode,
	McpOAuthProvider,
	refreshAuthorization,
	registerClient,
	startAuthorization,
} from "../../src/oauth/index.ts";
import { authorizationServer, authorizeInBrowser, routeResponse } from "./authorization-server.ts";

const ROUTE = "https://app.example/mcp/callback";

describe("the flow's requests", () => {
	it("register, authorize with PKCE, exchange the code and refresh, each an Effect", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer();
				const metadata = yield* discoverAuthorizationServerMetadata(server.origin);
				const client = yield* registerClient(server.origin, {
					metadata,
					clientMetadata: { client_name: "app", redirect_uris: [ROUTE] },
				});
				const { authorizationUrl, codeVerifier } = yield* startAuthorization(server.origin, {
					metadata,
					clientInformation: client,
					redirectUrl: ROUTE,
					state: "s1",
				});
				const { code } = routeResponse(yield* authorizeInBrowser(authorizationUrl.href));
				const tokens = yield* exchangeAuthorizationCode(server.origin, {
					metadata,
					clientInformation: client,
					code,
					codeVerifier,
					redirectUrl: ROUTE,
				});
				const refreshed = yield* refreshAuthorization(server.origin, {
					metadata,
					clientInformation: client,
					refreshToken: tokens.refresh_token ?? "",
				});
				const revoked = yield* Effect.flip(
					refreshAuthorization(server.origin, { metadata, clientInformation: client, refreshToken: "refresh-1" }),
				);
				return { client, tokens, refreshed, revoked };
			}),
		);
		expect(seen.client.client_id).toBe("client-1");
		expect(seen.tokens).toMatchObject({ access_token: "access-1" });
		expect(seen.refreshed).toMatchObject({ access_token: "access-2" });
		expect(seen.revoked).toMatchObject({ _tag: "OAuthError", code: "invalid_grant" });
	});
});

describe("authorizeMcp", () => {
	it("sends Pi's OAuth client to the browser, then exchanges the code it gets back", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer();
				const redirects: URL[] = [];
				const provider = new McpOAuthProvider({
					serverUrl: server.serverUrl,
					redirectUrl: ROUTE,
					clientMetadata: { client_name: "app" },
					onRedirect: (url) => void redirects.push(url),
				});
				const first = yield* authorizeMcp(provider, { serverUrl: server.serverUrl });
				const { code } = routeResponse(yield* authorizeInBrowser(redirects[0]?.href ?? ""));
				const second = yield* authorizeMcp(provider, { serverUrl: server.serverUrl, authorizationCode: code });
				return { first, second, tokens: yield* Effect.promise(() => Promise.resolve(provider.tokens())) };
			}),
		);
		expect(seen).toMatchObject({ first: "REDIRECT", second: "AUTHORIZED", tokens: { access_token: "access-1" } });
	});
});
