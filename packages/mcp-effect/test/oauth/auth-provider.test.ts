// The auth of connections to an OAuth-protected MCP server: Pi's auth provider as an `Auth` for the HTTP transport,
// against a local authorization server and its protected MCP endpoint.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Option, Queue, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { McpClient, streamableHttpTransport } from "../../src/index.ts";
import {
	adaptOAuthProvider,
	completeMcpSignIn,
	createMcpAuthProvider,
	McpOAuthProvider,
	memoryOAuthStore,
	type OAuthChallenge,
	type OAuthStore,
	type SignInOptions,
	startMcpSignIn,
} from "../../src/oauth/index.ts";
import {
	type AuthorizationServer,
	authorizationServer,
	authorizeInBrowser,
	routeResponse,
} from "./authorization-server.ts";

const CLIENT = { name: "test-client", version: "1.0.0" };
const ROUTE = "https://app.example/mcp/callback";

/** Signs in to `server` with `store` through the browser step. */
function signIn(server: AuthorizationServer, store: OAuthStore): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const options: SignInOptions = {
			serverUrl: server.serverUrl,
			store,
			settings: {},
			redirectUrl: ROUTE,
			clientName: "app",
		};
		const started = yield* startMcpSignIn(options);
		if (started.kind !== "redirect") return yield* Effect.die("expected the browser step");
		const response = routeResponse(yield* authorizeInBrowser(started.authorizationUrl));
		yield* completeMcpSignIn({ ...options, authorization: started, response });
	});
}

describe("createMcpAuthProvider", () => {
	it("sends the stored access token, so a signed-in client connects", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				yield* signIn(server, store);
				const auth = yield* createMcpAuthProvider({
					serverUrl: server.serverUrl,
					store,
					clientName: "app",
					settings: Effect.succeed({}),
				});
				const transport = yield* streamableHttpTransport({ url: server.serverUrl, openGetStream: false, auth });
				const client = yield* McpClient.connect(transport, CLIENT);
				return { server: client.initialize.serverInfo, sent: server.mcpAuthorizations };
			}),
		);
		expect(seen.server).toEqual({ name: "protected", version: "1" });
		expect(new Set(seen.sent)).toEqual(new Set(["Bearer access-1"]));
	});

	it("fails with McpOAuthAuthorizationRequiredError when the user has to sign in, and hands on the challenge", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const challenges = yield* Queue.unbounded<OAuthChallenge>();
				const auth = yield* createMcpAuthProvider({
					serverUrl: server.serverUrl,
					store,
					clientName: "app",
					settings: Effect.succeed({}),
					challenges,
				});
				const transport = yield* streamableHttpTransport({ url: server.serverUrl, openGetStream: false, auth });
				const error = yield* Effect.flip(McpClient.connect(transport, CLIENT));
				return { error, challenge: yield* Queue.take(challenges), origin: server.origin };
			}),
		);
		expect(seen.error._tag).toBe("McpOAuthAuthorizationRequiredError");
		expect(seen.challenge.resourceMetadataUrl?.href).toBe(`${seen.origin}/.well-known/oauth-protected-resource/mcp`);
	});
});

describe("adaptOAuthProvider", () => {
	it("reads the access token of Pi's OAuth client as an Auth", async () => {
		const token = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const provider = new McpOAuthProvider({
					serverUrl: server.serverUrl,
					redirectUrl: ROUTE,
					clientMetadata: { client_name: "app" },
					onRedirect: () => {},
				});
				yield* Effect.promise(() => provider.saveTokens({ access_token: "given", token_type: "Bearer" }));
				const auth = yield* adaptOAuthProvider(provider);
				return yield* auth.token;
			}),
		);
		expect(Option.map(token, Redacted.value)).toEqual(Option.some("given"));
	});
});
