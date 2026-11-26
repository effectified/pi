// The OAuth state store of one MCP server in Effect terms: where tokens, the client and a pending sign-in live, and
// the lock that keeps other processes from refreshing at the same time.

import { type McpOAuthServerStore, type McpOAuthState, MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { Effect } from "effect";
import { fromPi, type McpFailure, type McpRefreshLockBusyError } from "../errors.ts";
import type { RunInPi } from "../run-in-pi.ts";

/** Pi's `McpOAuthServerStore` in Effect terms. The application makes it durable (a file, a database row). */
export interface OAuthStore<R = never> {
	/** The stored state, or nothing. Pi ignores a state of another server URL. */
	readonly load: Effect.Effect<McpOAuthState | undefined, McpFailure, R>;
	/** Replaces the stored state. */
	readonly save: (state: McpOAuthState) => Effect.Effect<void, McpFailure, R>;
	/**
	 * Runs `effect` while no other process refreshes the server's tokens. Not reentrant: sign-in and the auth provider
	 * take it themselves. Fails with `McpRefreshLockBusyError` when another process holds it for the whole wait; sign-in
	 * then goes to the browser step.
	 */
	readonly withRefreshLock: <A, E, R2>(
		effect: Effect.Effect<A, E, R2>,
	) => Effect.Effect<A, E | McpRefreshLockBusyError, R | R2>;
}

/**
 * Pi's `MemoryOAuthStateStore`, with a refresh lock that only runs its Effect: for one process, and for tests. Its
 * state ends with the program.
 */
export function memoryOAuthStore(): Effect.Effect<OAuthStore> {
	return Effect.sync(() => {
		const memory = new MemoryOAuthStateStore();
		return {
			load: Effect.sync(() => memory.load()),
			save: (state) => Effect.sync(() => memory.save(state)),
			withRefreshLock: (effect) => effect,
		};
	});
}

/** `store` as Pi's `McpOAuthServerStore`, its Effects run with `run`. */
export function toPiStore<R>(store: OAuthStore<R>, run: RunInPi<R>): McpOAuthServerStore {
	return {
		load: () => run(store.load),
		save: (state) => run(store.save(state)),
		withRefreshLock: (fn) => run(store.withRefreshLock(Effect.tryPromise({ try: fn, catch: fromPi }))),
	};
}
