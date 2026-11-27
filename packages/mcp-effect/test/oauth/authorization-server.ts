// A local OAuth-protected MCP server for the tests, on loopback for the scope: discovery, dynamic client registration,
// PKCE, rotating refresh tokens, and an MCP endpoint at `<origin>/mcp` that takes only the latest access token.

import { createHash } from "node:crypto";
import { Effect, type Scope } from "effect";
import { json, listen, readBody } from "../http-server.ts";

/** What the server saw, for the tests to check. */
export interface AuthorizationServer {
	readonly origin: string;
	/** The MCP server's URL, `<origin>/mcp`. */
	readonly serverUrl: string;
	/** Client metadata of each dynamic client registration. */
	readonly registrations: Array<Record<string, unknown>>;
	/** Parameters of each token request. */
	readonly tokenRequests: Array<URLSearchParams>;
	/** The Authorization header of each request to the MCP endpoint. */
	readonly mcpAuthorizations: Array<string | undefined>;
}

/** Starts a new server; it stops when the scope closes. */
export const authorizationServer: Effect.Effect<AuthorizationServer, never, Scope.Scope> = Effect.gen(function* () {
	const registrations: Array<Record<string, unknown>> = [];
	const tokenRequests: Array<URLSearchParams> = [];
	const mcpAuthorizations: Array<string | undefined> = [];
	const challenges = new Map<string, string>();
	const refreshTokens = new Set<string>();
	let issued = 0;
	let authorizations = 0;
	const issueTokens = () => {
		issued++;
		refreshTokens.add(`refresh-${issued}`);
		return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "Bearer" };
	};
	const origin = yield* listen(async (request, response, origin) => {
		const url = new URL(request.url ?? "/", origin);
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case "/register": {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				registrations.push(metadata);
				return json(response, 201, { ...metadata, client_id: `client-${registrations.length}` });
			}
			case "/authorize": {
				authorizations++;
				const code = `code-${authorizations}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			case "/token": {
				const params = new URLSearchParams(await readBody(request));
				tokenRequests.push(params);
				if (params.get("grant_type") === "authorization_code") {
					const code = params.get("code") ?? "";
					const verifier = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (challenges.get(code) !== verifier) return json(response, 400, { error: "invalid_grant" });
					challenges.delete(code);
					return json(response, 200, issueTokens());
				}
				if (!refreshTokens.delete(params.get("refresh_token") ?? "")) {
					return json(response, 400, { error: "invalid_grant", error_description: "refresh token revoked" });
				}
				return json(response, 200, issueTokens());
			}
			case "/mcp": {
				const authorization = request.headers.authorization;
				mcpAuthorizations.push(authorization);
				if (authorization !== `Bearer access-${issued}` || issued === 0) {
					const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
					response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${metadata}"` }).end();
					return;
				}
				if (request.method !== "POST") return void response.writeHead(405).end();
				const body = JSON.parse(await readBody(request)) as { id?: number; method: string };
				if (body.id === undefined) return void response.writeHead(202).end();
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								capabilities: {},
								serverInfo: { name: "protected", version: "1" },
							}
						: {};
				return json(response, 200, { jsonrpc: "2.0", id: body.id, result });
			}
			default:
				response.writeHead(404).end();
		}
	});
	return { origin, serverUrl: `${origin}/mcp`, registrations, tokenRequests, mcpAuthorizations };
});

/** Follows an authorization URL as a browser would, up to the redirect back to the application. */
export function authorizeInBrowser(authorizationUrl: string): Effect.Effect<string> {
	return Effect.promise(async () => {
		const response = await fetch(authorizationUrl, { redirect: "manual" });
		return response.headers.get("location") ?? "";
	});
}

/** The authorization response a callback route reads from the query of `location`. */
export function routeResponse(location: string): { code: string; state: string } {
	const query = new URL(location).searchParams;
	return { code: query.get("code") ?? "", state: query.get("state") ?? "" };
}
