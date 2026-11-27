// How the authorization response of a sign-in reaches a local application, in Effect terms: a loopback callback
// server for the scope, or a redirect URL the user pastes, whichever comes first.

import {
	type McpAuthorizationResponse,
	type McpLoopbackCallback,
	type McpSignInRedirect,
	listenForLoopbackSignIn as piListenForLoopbackSignIn,
	responseFromRedirectUrl as piResponseFromRedirectUrl,
	waitForLoopbackSignIn as piWaitForLoopbackSignIn,
} from "@earendil-works/pi-mcp/oauth";
import { Effect, type Scope } from "effect";
import { fromPi, type McpFailure } from "../errors.ts";
import { currentRunner } from "../run-in-pi.ts";
import { type OAuthSettings, toPiSettings } from "./settings.ts";
import { type OAuthStore, toPiStore } from "./store.ts";

/** Pi's options of `listenForLoopbackSignIn`, with an `OAuthStore` and the client secret `Redacted`. */
export interface LoopbackOptions<R = never> extends Omit<
	Parameters<typeof piListenForLoopbackSignIn>[0],
	"store" | "settings"
> {
	readonly store: OAuthStore<R>;
	readonly settings: OAuthSettings;
}

/**
 * Listens for the authorization response of a sign-in on loopback, where the settings say (Pi's
 * `listenForLoopbackSignIn`), until the scope closes. Pass its `redirectUrl` to both halves of the sign-in.
 */
export const listenForLoopbackSignIn: <R = never>(
	options: LoopbackOptions<R>,
) => Effect.Effect<McpLoopbackCallback, McpFailure, Scope.Scope | R> = Effect.fn("McpOAuth.listenForLoopbackSignIn")(
	function* <R>(options: LoopbackOptions<R>) {
		const run = yield* currentRunner<R>();
		const { store, settings, ...rest } = options;
		return yield* Effect.acquireRelease(
			Effect.tryPromise({
				try: () =>
					piListenForLoopbackSignIn({ ...rest, settings: toPiSettings(settings), store: toPiStore(store, run) }),
				catch: fromPi,
			}),
			(loopback) => Effect.promise(() => loopback.callback.close()),
		);
	},
);

/** What `waitForLoopbackSignIn` waits on. */
export interface WaitOptions<R = never> {
	readonly callback: McpLoopbackCallback["callback"];
	/** The `redirect` result of `startMcpSignIn`. */
	readonly authorization: McpSignInRedirect;
	/**
	 * Asks the user for the redirect URL, for when the browser cannot reach the loopback callback (over SSH). It is
	 * interrupted once the callback arrives. `undefined` or an empty string cancels the sign-in, as in Pi.
	 */
	readonly promptForRedirectUrl?: Effect.Effect<string | undefined, McpFailure, R>;
}

/**
 * The authorization response from the loopback callback, or from the redirect URL the user pastes, whichever comes
 * first (Pi's `waitForLoopbackSignIn`). Interrupting it stops the wait.
 */
export const waitForLoopbackSignIn: <R = never>(
	options: WaitOptions<R>,
) => Effect.Effect<McpAuthorizationResponse, McpFailure, R> = Effect.fn("McpOAuth.waitForLoopbackSignIn")(function* <R>(
	options: WaitOptions<R>,
) {
	const run = yield* currentRunner<R>();
	const { promptForRedirectUrl, ...rest } = options;
	return yield* Effect.tryPromise({
		try: (signal) =>
			piWaitForLoopbackSignIn({
				...rest,
				signal,
				...(promptForRedirectUrl === undefined
					? {}
					: { promptForRedirectUrl: (stop) => run(promptForRedirectUrl, stop) }),
			}),
		catch: fromPi,
	});
});

/**
 * The authorization response in a redirect URL the user pasted. Fails when the URL is not on the sign-in's redirect
 * URI, carries another `state`, or reports an error.
 */
export const responseFromRedirectUrl = Effect.fn("McpOAuth.responseFromRedirectUrl")(
	(input: string, authorization: Pick<McpSignInRedirect, "state" | "redirectUrl">) =>
		Effect.try({ try: () => piResponseFromRedirectUrl(input, authorization), catch: fromPi }),
);
