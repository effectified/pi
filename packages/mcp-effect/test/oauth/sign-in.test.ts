// Sign-in in two halves against a local authorization server, with the state in an Effect store.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { completeMcpSignIn, memoryOAuthStore, type SignInOptions, startMcpSignIn } from "../../src/oauth/index.ts";
import { authorizationServer, authorizeInBrowser, routeResponse } from "./authorization-server.ts";

/** The application's callback route, which the test reads the redirect for instead of serving. */
const ROUTE = "https://app.example/mcp/callback";

describe("startMcpSignIn and completeMcpSignIn", () => {
	it("register a client, send the browser step, exchange the code, and save the tokens in the store", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const options: SignInOptions = {
					serverUrl: server.serverUrl,
					store,
					settings: { scope: "issues:read" },
					redirectUrl: ROUTE,
					clientName: "app",
				};
				const started = yield* startMcpSignIn(options);
				if (started.kind !== "redirect") return yield* Effect.die("expected the browser step");
				const response = routeResponse(yield* authorizeInBrowser(started.authorizationUrl));
				yield* completeMcpSignIn({ ...options, authorization: started, response });
				const saved = Option.getOrUndefined(yield* store.load);
				// Signed in: the next sign-in refreshes the stored tokens instead of sending the user to the browser.
				const again = yield* startMcpSignIn(options);
				return {
					started,
					saved,
					again,
					registrations: server.registrations,
					refreshed: Option.getOrUndefined(yield* store.load),
				};
			}),
		);
		expect(seen.started).toMatchObject({ kind: "redirect", redirectUrl: ROUTE, scope: "issues:read" });
		expect(seen.registrations).toMatchObject([{ client_name: "app", redirect_uris: [ROUTE] }]);
		expect(seen.saved?.tokens).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
		expect(seen.again).toEqual({ kind: "authorized" });
		expect(seen.refreshed?.tokens).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
	});

	it("fails completing with the response of another sign-in", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const options: SignInOptions = {
					serverUrl: server.serverUrl,
					store,
					settings: {},
					redirectUrl: ROUTE,
					clientName: "app",
				};
				const started = yield* startMcpSignIn(options);
				if (started.kind !== "redirect") return yield* Effect.die("expected the browser step");
				return yield* Effect.flip(
					completeMcpSignIn({ ...options, authorization: started, response: { code: "x", state: "another" } }),
				);
			}),
		);
		expect(error).toMatchObject({
			_tag: "McpUnexpectedError",
			message: "The authorization response belongs to a different sign-in",
		});
	});
});
