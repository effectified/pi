// OAuth discovery of an MCP server as Effects, against a local authorization server.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	selectResource,
} from "../../src/oauth/index.ts";
import { authorizationServer } from "./authorization-server.ts";

describe("discovery", () => {
	it("finds the resource metadata, the authorization server and its metadata", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer();
				return {
					origin: server.origin,
					resource: yield* discoverProtectedResourceMetadata(server.serverUrl),
					metadata: yield* discoverAuthorizationServerMetadata(server.origin),
					info: yield* discoverOAuthServerInfo(server.serverUrl),
				};
			}),
		);
		expect(seen.resource).toEqual({ resource: `${seen.origin}/mcp`, authorization_servers: [seen.origin] });
		expect(seen.metadata?.token_endpoint).toBe(`${seen.origin}/token`);
		expect(String(seen.info.authorizationServerUrl)).toBe(seen.origin);
		expect(seen.info.authorizationServerMetadata?.issuer).toBe(seen.origin);
	});

	it("fails with a tagged error when nothing answers", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const server = yield* Effect.scoped(authorizationServer());
				return yield* Effect.flip(discoverProtectedResourceMetadata(server.serverUrl));
			}),
		);
		expect(error._tag).toBe("McpUnexpectedError");
	});
});

describe("selectResource", () => {
	it("names the resource that covers the server, and fails for one that does not", async () => {
		const metadata = { resource: "https://mcp.example/mcp" };
		expect(await Effect.runPromise(selectResource("https://mcp.example/mcp/v1", metadata))).toBe(metadata.resource);
		const error = await Effect.runPromise(Effect.flip(selectResource("https://other.example/mcp", metadata)));
		expect(error.message).toContain("does not match MCP server");
	});
});
