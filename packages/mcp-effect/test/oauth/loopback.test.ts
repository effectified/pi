// The authorization response of a sign-in reaching a local application: a loopback callback server for the scope,
// or a redirect URL the user pastes.

import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	completeMcpSignIn,
	listenForLoopbackSignIn,
	memoryOAuthStore,
	responseFromRedirectUrl,
	type SignInOptions,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "../../src/oauth/index.ts";
import { authorizationServer, authorizeInBrowser } from "./authorization-server.ts";

describe("listenForLoopbackSignIn and waitForLoopbackSignIn", () => {
	it("receive the browser's redirect on loopback and complete the sign-in; the scope closes the server", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const { redirectUrl, signedIn } = yield* Effect.scoped(
					Effect.gen(function* () {
						const loopback = yield* listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings: {} });
						const options: SignInOptions = {
							serverUrl: server.serverUrl,
							store,
							settings: {},
							redirectUrl: loopback.redirectUrl,
							clientName: "app",
						};
						const started = yield* startMcpSignIn(options);
						if (started.kind !== "redirect") return yield* Effect.die("expected the browser step");
						const waiting = yield* Effect.forkChild(
							waitForLoopbackSignIn({ callback: loopback.callback, authorization: started }),
							{ startImmediately: true },
						);
						// The browser follows the authorization server's redirect to the loopback callback.
						const location = yield* authorizeInBrowser(started.authorizationUrl);
						yield* Effect.promise(() => fetch(location).then((response) => response.text()));
						const response = yield* Fiber.join(waiting);
						yield* completeMcpSignIn({ ...options, authorization: started, response });
						return { redirectUrl: loopback.redirectUrl, signedIn: Option.getOrUndefined(yield* store.load) };
					}),
				);
				const closed = yield* Effect.promise(() =>
					fetch(redirectUrl).then(
						() => false,
						() => true,
					),
				);
				return { redirectUrl, signedIn, closed };
			}),
		);
		expect(seen.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(seen.signedIn?.tokens?.access_token).toBe("access-1");
		expect(seen.closed).toBe(true);
	});

	it("takes the redirect URL the user pastes when the prompt answers first", async () => {
		const response = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const loopback = yield* listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings: {} });
				const started = yield* startMcpSignIn({
					serverUrl: server.serverUrl,
					store,
					settings: {},
					redirectUrl: loopback.redirectUrl,
					clientName: "app",
				});
				if (started.kind !== "redirect") return yield* Effect.die("expected the browser step");
				// The user copies the address the browser could not open (over SSH, say) and pastes it.
				const pasted = yield* authorizeInBrowser(started.authorizationUrl);
				return yield* waitForLoopbackSignIn({
					callback: loopback.callback,
					authorization: started,
					promptForRedirectUrl: Effect.succeed(pasted),
				});
			}),
		);
		expect(response).toMatchObject({ code: "code-1", state: expect.any(String) });
	});

	it("cancels the sign-in when the user pastes nothing", async () => {
		const error = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				const loopback = yield* listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings: {} });
				const authorization = {
					kind: "redirect" as const,
					authorizationUrl: "",
					redirectUrl: loopback.redirectUrl,
					state: "s",
				};
				return yield* Effect.flip(
					waitForLoopbackSignIn({
						callback: loopback.callback,
						authorization,
						promptForRedirectUrl: Effect.succeed(""),
					}),
				);
			}),
		);
		expect(error._tag).toBe("McpSignInCancelledError");
	});
});

describe("responseFromRedirectUrl", () => {
	const authorization = { state: "s1", redirectUrl: "http://127.0.0.1:8080/callback" };

	it("reads the code and state of a pasted redirect URL", async () => {
		const response = await Effect.runPromise(
			responseFromRedirectUrl("http://127.0.0.1:8080/callback?code=c1&state=s1", authorization),
		);
		expect(response).toEqual({ code: "c1", state: "s1" });
	});

	it("fails for a URL of another sign-in", async () => {
		const error = await Effect.runPromise(
			Effect.flip(responseFromRedirectUrl("http://127.0.0.1:8080/callback?code=c1&state=other", authorization)),
		);
		expect(error).toMatchObject({
			_tag: "McpUnexpectedError",
			message: "The redirect URL belongs to a different sign-in",
		});
	});
});
