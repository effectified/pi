// Sign-in to an OAuth-protected MCP server in Effect terms: Pi's two halves, start and complete, each an Effect that
// interrupting cancels, with the state store given as Effects.

import {
	type McpAuthorizationResponse,
	type McpSignInOptions,
	type McpSignInRedirect,
	type McpSignInStart,
	completeMcpSignIn as piCompleteMcpSignIn,
	startMcpSignIn as piStartMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import { fromPi, type McpFailure } from "../errors.ts";
import { currentRunner } from "../run-in-pi.ts";
import { type OAuthSettings, toPiSettings } from "./settings.ts";
import { type OAuthStore, toPiStore } from "./store.ts";

/**
 * Pi's sign-in options with an `OAuthStore` and the client secret `Redacted`. The fiber owns cancellation. Pass the
 * same to both halves.
 */
export interface SignInOptions<R = never> extends Omit<McpSignInOptions, "store" | "settings" | "signal"> {
	readonly store: OAuthStore<R>;
	readonly settings: OAuthSettings;
}

/** `SignInOptions`, and the browser step and its answer, for `completeMcpSignIn`. */
export interface CompleteSignInOptions<R = never> extends SignInOptions<R> {
	/** The `redirect` result of `startMcpSignIn`. */
	readonly authorization: McpSignInRedirect;
	readonly response: McpAuthorizationResponse;
}

/**
 * First half of a sign-in: Pi's `startMcpSignIn`. Refreshes the stored tokens when it can (`authorized`), or prepares
 * the browser step (`redirect`: open `authorizationUrl`). Interrupting it cancels the sign-in; a refresh already sent
 * still completes and saves its tokens, as in Pi.
 */
export const startMcpSignIn: <R = never>(options: SignInOptions<R>) => Effect.Effect<McpSignInStart, McpFailure, R> =
	Effect.fn("McpOAuth.startMcpSignIn")(function* <R>(options: SignInOptions<R>) {
		const run = yield* currentRunner<R>();
		const { store, settings, ...rest } = options;
		return yield* Effect.tryPromise({
			try: (signal) =>
				piStartMcpSignIn({ ...rest, settings: toPiSettings(settings), store: toPiStore(store, run), signal }),
			catch: fromPi,
		});
	});

/**
 * Second half of a sign-in: Pi's `completeMcpSignIn`. Exchanges the authorization code of `response` and saves the
 * tokens. A redirect URL the user pasted goes through `responseFromRedirectUrl` first.
 */
export const completeMcpSignIn: <R = never>(options: CompleteSignInOptions<R>) => Effect.Effect<void, McpFailure, R> =
	Effect.fn("McpOAuth.completeMcpSignIn")(function* <R>(options: CompleteSignInOptions<R>) {
		const run = yield* currentRunner<R>();
		const { store, settings, ...rest } = options;
		yield* Effect.tryPromise({
			try: (signal) =>
				piCompleteMcpSignIn({ ...rest, settings: toPiSettings(settings), store: toPiStore(store, run), signal }),
			catch: fromPi,
		});
	});
