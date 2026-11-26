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
import { type OAuthStore, toPiStore } from "./store.ts";

/** Pi's sign-in options with an `OAuthStore`. The fiber owns cancellation. Pass the same to both halves. */
export interface SignInOptions<R = never> extends Omit<McpSignInOptions, "store" | "signal"> {
	readonly store: OAuthStore<R>;
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
export function startMcpSignIn<R = never>(options: SignInOptions<R>): Effect.Effect<McpSignInStart, McpFailure, R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const { store, ...rest } = options;
		return yield* Effect.tryPromise({
			try: (signal) => piStartMcpSignIn({ ...rest, store: toPiStore(store, run), signal }),
			catch: fromPi,
		});
	});
}

/**
 * Second half of a sign-in: Pi's `completeMcpSignIn`. Exchanges the authorization code of `response` and saves the
 * tokens. A redirect URL the user pasted goes through `responseFromRedirectUrl` first.
 */
export function completeMcpSignIn<R = never>(options: CompleteSignInOptions<R>): Effect.Effect<void, McpFailure, R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const { store, ...rest } = options;
		yield* Effect.tryPromise({
			try: (signal) => piCompleteMcpSignIn({ ...rest, store: toPiStore(store, run), signal }),
			catch: fromPi,
		});
	});
}
