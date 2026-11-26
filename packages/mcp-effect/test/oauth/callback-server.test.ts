// pi-mcp's OAuth callback server for the scope, and the wait for one authorization response on it.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { listenForOAuthCallback, waitForOAuthCallback } from "../../src/oauth/index.ts";

/** Opens `url` as the browser would after the authorization server's redirect. */
const visit = (url: string) => Effect.promise(() => fetch(url).then((response) => response.status));

describe("listenForOAuthCallback and waitForOAuthCallback", () => {
	it("deliver the code and state of the redirect, and close the server with the scope", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const { redirectUrl, callback, status } = yield* Effect.scoped(
					Effect.gen(function* () {
						const server = yield* listenForOAuthCallback({ path: "/oauth/done" });
						const waiting = yield* Effect.forkChild(waitForOAuthCallback(server, "s1"), {
							startImmediately: true,
						});
						const status = yield* visit(`${server.redirectUrl}?code=c1&state=s1&iss=https%3A%2F%2Fissuer`);
						return { redirectUrl: server.redirectUrl, callback: yield* Fiber.join(waiting), status };
					}),
				);
				const closed = yield* Effect.promise(() =>
					fetch(redirectUrl).then(
						() => false,
						() => true,
					),
				);
				return { redirectUrl, callback, status, closed };
			}),
		);
		expect(seen.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/done$/);
		expect(seen.callback).toEqual({ code: "c1", state: "s1", iss: "https://issuer" });
		expect(seen.status).toBe(200);
		expect(seen.closed).toBe(true);
	});

	it("fails the wait with the authorization server's error", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const server = yield* listenForOAuthCallback();
				const waiting = yield* Effect.forkChild(Effect.flip(waitForOAuthCallback(server, "s1")), {
					startImmediately: true,
				});
				yield* visit(`${server.redirectUrl}?error=access_denied&error_description=The+user+said+no&state=s1`);
				return yield* Fiber.join(waiting);
			}),
		);
		expect(error).toMatchObject({ _tag: "McpUnexpectedError", message: "The user said no" });
	});
});
