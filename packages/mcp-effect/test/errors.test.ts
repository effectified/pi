// pi-mcp's error classes as one tagged union, and the way back to Pi's classes for the callbacks Pi runs.

import * as PiMcp from "@earendil-works/pi-mcp";
import * as PiOAuth from "@earendil-works/pi-mcp/oauth";
import { describe, expect, it } from "vitest";
import { fromPi, type McpFailure, toPi } from "../src/errors.ts";

/** One instance of every error class pi-mcp and its OAuth subpath export, with the tag and fields it maps to. */
const CASES: ReadonlyArray<readonly [Error, Record<string, unknown>]> = [
	[
		new PiMcp.McpError(-32602, "bad", { at: "x" }),
		{ _tag: "McpError", code: -32602, message: "bad", data: { at: "x" } },
	],
	[new PiMcp.McpConnectionClosedError("gone"), { _tag: "McpConnectionClosedError", message: "gone" }],
	[new PiMcp.McpTimeoutError(5000), { _tag: "McpTimeoutError", timeoutMs: 5000 }],
	[new PiMcp.McpAbortError("stopped"), { _tag: "McpAbortError", message: "stopped" }],
	[
		new PiMcp.McpHttpError(502, "upstream", "body"),
		{ _tag: "McpHttpError", status: 502, message: "upstream", body: "body" },
	],
	[
		new PiMcp.McpAuthRequiredError(
			new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer scope="a"' } }),
			"denied",
		),
		{ _tag: "McpAuthRequiredError", status: 401, body: "denied", wwwAuthenticate: 'Bearer scope="a"' },
	],
	[new PiMcp.McpSessionExpiredError("old"), { _tag: "McpSessionExpiredError", body: "old" }],
	[
		new PiOAuth.OAuthError("invalid_grant", "expired", "https://errors"),
		{ _tag: "OAuthError", code: "invalid_grant", message: "expired", errorUri: "https://errors" },
	],
	[
		new PiOAuth.OAuthIssuerMismatchError("https://a", undefined),
		{ _tag: "OAuthIssuerMismatchError", expected: "https://a", received: undefined },
	],
	[
		new PiOAuth.OAuthInsecureEndpointError("http://token"),
		{ _tag: "OAuthInsecureEndpointError", endpoint: "http://token" },
	],
	[new PiOAuth.OAuthRegistrationError(400, "no"), { _tag: "OAuthRegistrationError", status: 400, body: "no" }],
	[new PiOAuth.McpOAuthAuthorizationRequiredError(), { _tag: "McpOAuthAuthorizationRequiredError" }],
	[new PiOAuth.McpRefreshLockBusyError(), { _tag: "McpRefreshLockBusyError" }],
	[new PiOAuth.McpSignInCancelledError(), { _tag: "McpSignInCancelledError" }],
];

describe("fromPi", () => {
	it("gives every Pi error class its own tag, with the class's fields and message", () => {
		for (const [error, expected] of CASES) {
			const failure = fromPi(error);
			expect(failure).toMatchObject(expected);
			expect(failure.message).toBe(error.message);
		}
	});

	it("tags a subclass by itself, not by the class it extends", () => {
		expect(fromPi(new PiMcp.McpSessionExpiredError())._tag).toBe("McpSessionExpiredError");
	});

	it("keeps anything else whole as McpUnexpectedError, with its message", () => {
		const cause = new TypeError("fetch failed");
		const failure = fromPi(cause);
		expect(failure).toMatchObject({ _tag: "McpUnexpectedError", cause, message: "fetch failed" });
		expect(fromPi("text").message).toBe("text");
	});
});

describe("toPi", () => {
	it("gives back an instance of the same Pi class with the same fields", () => {
		for (const [error] of CASES) {
			const back = toPi(fromPi(error));
			expect(back).toBeInstanceOf(error.constructor);
			expect(back).toMatchObject({ ...error, message: error.message });
		}
	});

	it("gives back the cause of an McpUnexpectedError itself", () => {
		const cause = new RangeError("out");
		expect(toPi(fromPi(cause))).toBe(cause);
		const failure: McpFailure = fromPi(42);
		expect(toPi(failure).message).toBe("42");
	});
});
