// The OAuth state store as Effects: Pi's memory store, and any store handed to Pi as its own.

import { McpRefreshLockBusyError as PiMcpRefreshLockBusyError } from "@earendil-works/pi-mcp/oauth";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { McpRefreshLockBusyError, memoryOAuthStore, type OAuthStore } from "../../src/oauth/index.ts";
import { toPiStore } from "../../src/oauth/store.ts";
import { currentRunner } from "../../src/run-in-pi.ts";

describe("memoryOAuthStore", () => {
	it("keeps the last state saved, a copy, and its lock only runs the Effect", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* memoryOAuthStore;
				const empty = yield* store.load;
				const state = { serverUrl: "https://mcp.example/mcp", tokens: { access_token: "a", token_type: "Bearer" } };
				yield* store.save(state);
				const loaded = Option.getOrThrow(yield* store.load);
				const locked = yield* store.withRefreshLock(Effect.succeed("ran"));
				return { empty: Option.isNone(empty), loaded, same: loaded === state, locked };
			}),
		);
		expect(seen).toMatchObject({ empty: true, same: false, locked: "ran" });
		expect(seen.loaded.tokens?.access_token).toBe("a");
	});

	it("is a new store each time it runs", async () => {
		const other = await Effect.runPromise(
			Effect.gen(function* () {
				const first = yield* memoryOAuthStore;
				yield* first.save({ serverUrl: "https://mcp.example/mcp" });
				return yield* (yield* memoryOAuthStore).load;
			}),
		);
		expect(Option.isNone(other)).toBe(true);
	});
});

describe("toPiStore", () => {
	it("gives Pi the store, and a busy lock as Pi's McpRefreshLockBusyError, which sign-in checks for", async () => {
		const busy: OAuthStore = {
			load: Effect.succeedNone,
			save: () => Effect.void,
			withRefreshLock: () => Effect.fail(new McpRefreshLockBusyError({ message: "busy" })),
		};
		const run = await Effect.runPromise(currentRunner());
		const store = toPiStore(busy, run);
		await expect(store.load()).resolves.toBeUndefined();
		await expect(store.withRefreshLock(async () => "never")).rejects.toBeInstanceOf(PiMcpRefreshLockBusyError);
	});

	it("runs Pi's function under the lock, and passes on what it rejects with", async () => {
		const order: string[] = [];
		const logged: OAuthStore = {
			load: Effect.succeedNone,
			save: () => Effect.void,
			withRefreshLock: (effect) =>
				Effect.sync(() => order.push("locked")).pipe(
					Effect.andThen(effect),
					Effect.ensuring(Effect.sync(() => order.push("released"))),
				),
		};
		const store = toPiStore(logged, await Effect.runPromise(currentRunner()));
		expect(await store.withRefreshLock(async () => order.push("ran"))).toBe(2);
		const cause = new Error("refresh failed");
		await expect(
			store.withRefreshLock(async () => {
				throw cause;
			}),
		).rejects.toBe(cause);
		expect(order).toEqual(["locked", "ran", "released", "locked", "released"]);
	});
});
