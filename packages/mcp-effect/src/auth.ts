// pi-mcp's `AuthProvider` port in Effect terms: where an HTTP transport gets its bearer token, and what it does after
// a 401, written as Effects and handed to Pi as its promise callbacks.

import type { AuthProvider, UnauthorizedContext } from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { fromPi, type McpFailure } from "./errors.ts";
import type { RunInPi } from "./run-in-pi.ts";

/** The bearer tokens of an MCP HTTP transport. Made by the application, or by the OAuth subpath's auth provider. */
export interface Auth<R = never> {
	/** The token for the next request. May refresh it first: the transport asks only before requests it waits on. */
	readonly token: Effect.Effect<string | undefined, McpFailure, R>;
	/**
	 * Runs after a 401, or a 403 asking for more scope; the transport then retries once with `token`. Failing fails the
	 * request with that failure.
	 */
	readonly onUnauthorized?: (context: UnauthorizedContext) => Effect.Effect<void, McpFailure, R>;
}

/** `auth` as Pi's `AuthProvider`, its Effects run with `run`. */
export function toAuthProvider<R>(auth: Auth<R>, run: RunInPi<R>): AuthProvider {
	const { onUnauthorized } = auth;
	return {
		token: () => run(auth.token),
		...(onUnauthorized === undefined ? {} : { onUnauthorized: (context) => run(onUnauthorized(context)) }),
	};
}

/** Pi's `provider` as an `Auth`: each call one Effect, failing with its tagged error. */
export function fromAuthProvider(provider: AuthProvider): Auth {
	const { onUnauthorized } = provider;
	return {
		token: Effect.tryPromise({ try: () => provider.token(), catch: fromPi }),
		...(onUnauthorized === undefined
			? {}
			: {
					onUnauthorized: (context) =>
						Effect.tryPromise({ try: () => onUnauthorized.call(provider, context), catch: fromPi }),
				}),
	};
}
