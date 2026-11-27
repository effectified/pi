// The `AuthProvider` port as Effects: an `Auth` handed to Pi, and Pi's provider read back as an `Auth`, the token
// `Redacted` on our side.

import type { AuthProvider, UnauthorizedContext } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError as PiAuthorizationRequired } from "@earendil-works/pi-mcp/oauth";
import { Effect, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { fromAuthProvider, toAuthProvider } from "../src/auth.ts";
import { McpOAuthAuthorizationRequiredError } from "../src/index.ts";
import { currentRunner } from "../src/run-in-pi.ts";

const CONTEXT: UnauthorizedContext = {
	response: new Response(null, { status: 401 }),
	serverUrl: new URL("https://mcp.example/mcp"),
	fetch: globalThis.fetch,
	token: "old",
};

describe("toAuthProvider", () => {
	it("gives Pi the token revealed, and runs onUnauthorized with Pi's context", async () => {
		const seen: UnauthorizedContext[] = [];
		const run = await Effect.runPromise(currentRunner());
		const provider = toAuthProvider(
			{
				token: Effect.succeedSome(Redacted.make("fresh")),
				onUnauthorized: (context) => Effect.sync(() => void seen.push(context)),
			},
			run,
		);
		expect(await provider.token()).toBe("fresh");
		await provider.onUnauthorized?.(CONTEXT);
		expect(seen).toEqual([CONTEXT]);
	});

	it("gives Pi no token for none", async () => {
		const provider = toAuthProvider({ token: Effect.succeedNone }, await Effect.runPromise(currentRunner()));
		expect(await provider.token()).toBeUndefined();
	});

	it("rejects with Pi's class of the failure, and leaves onUnauthorized out when the Auth has none", async () => {
		const run = await Effect.runPromise(currentRunner());
		const provider = toAuthProvider(
			{ token: Effect.fail(McpOAuthAuthorizationRequiredError.make({ message: "sign in" })) },
			run,
		);
		await expect(provider.token()).rejects.toBeInstanceOf(PiAuthorizationRequired);
		expect(provider.onUnauthorized).toBeUndefined();
	});
});

describe("fromAuthProvider", () => {
	it("reads Pi's provider as Effects, its token Redacted and its rejections tagged", async () => {
		const provider: AuthProvider = {
			token: async () => "stored",
			onUnauthorized: async () => {
				throw new PiAuthorizationRequired();
			},
		};
		const auth = fromAuthProvider(provider);
		const token = await Effect.runPromise(auth.token);
		expect(Option.map(token, Redacted.value)).toEqual(Option.some("stored"));
		// What a log or an error shows of it.
		expect(String(Option.getOrThrow(token))).not.toContain("stored");
		const failure = await Effect.runPromise(Effect.flip(auth.onUnauthorized?.(CONTEXT) ?? Effect.void));
		expect(failure).toMatchObject({ _tag: "McpOAuthAuthorizationRequiredError" });
	});

	it("reads no token as none", async () => {
		const auth = fromAuthProvider({ token: async () => undefined });
		expect(Option.isNone(await Effect.runPromise(auth.token))).toBe(true);
	});
});
