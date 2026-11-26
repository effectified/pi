// The typed failures of this package: every error class pi-mcp and its OAuth subpath throw, as one closed union of
// tagged errors, and the way back to Pi's classes for the callbacks Pi runs.

import {
	McpAbortError as PiMcpAbortError,
	McpAuthRequiredError as PiMcpAuthRequiredError,
	McpConnectionClosedError as PiMcpConnectionClosedError,
	McpError as PiMcpError,
	McpHttpError as PiMcpHttpError,
	McpSessionExpiredError as PiMcpSessionExpiredError,
	McpTimeoutError as PiMcpTimeoutError,
} from "@earendil-works/pi-mcp";
import {
	McpOAuthAuthorizationRequiredError as PiMcpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError as PiMcpRefreshLockBusyError,
	McpSignInCancelledError as PiMcpSignInCancelledError,
	OAuthError as PiOAuthError,
	OAuthInsecureEndpointError as PiOAuthInsecureEndpointError,
	OAuthIssuerMismatchError as PiOAuthIssuerMismatchError,
	OAuthRegistrationError as PiOAuthRegistrationError,
} from "@earendil-works/pi-mcp/oauth";
import { Predicate, Schema } from "effect";

/** A JSON-RPC error: the server answered a request with `code` and `message`, or a message was not valid JSON-RPC. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
	code: Schema.Number,
	message: Schema.String,
	data: Schema.Unknown,
}) {}

/** The connection closed, or was never open, while the call needed it. */
export class McpConnectionClosedError extends Schema.TaggedError<McpConnectionClosedError>()(
	"McpConnectionClosedError",
	{ message: Schema.String },
) {}

/** The server neither answered nor reported progress for `timeoutMs` milliseconds. */
export class McpTimeoutError extends Schema.TaggedError<McpTimeoutError>()("McpTimeoutError", {
	timeoutMs: Schema.Number,
}) {
	override get message(): string {
		return `MCP request timed out after ${this.timeoutMs}ms`;
	}
}

/**
 * Pi gave a request up because its signal was aborted. The calls of this package own that signal: interrupting the
 * calling fiber cancels the request as interruption, never as this error.
 */
export class McpAbortError extends Schema.TaggedError<McpAbortError>()("McpAbortError", {
	message: Schema.String,
}) {}

/** An MCP HTTP request failed with `status`; `body` is the start of the response body. */
export class McpHttpError extends Schema.TaggedError<McpHttpError>()("McpHttpError", {
	status: Schema.Number,
	message: Schema.String,
	body: Schema.String,
}) {}

/** The MCP server answered 401, or 403 asking for more scope; `wwwAuthenticate` is its challenge. */
export class McpAuthRequiredError extends Schema.TaggedError<McpAuthRequiredError>()("McpAuthRequiredError", {
	status: Schema.Number,
	message: Schema.String,
	body: Schema.String,
	wwwAuthenticate: Schema.NullOr(Schema.String),
}) {}

/** The MCP server no longer knows the session (404 to a request that carried a session id). */
export class McpSessionExpiredError extends Schema.TaggedError<McpSessionExpiredError>()("McpSessionExpiredError", {
	message: Schema.String,
	body: Schema.String,
}) {}

/** An authorization server answered with the OAuth error `code`. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
	code: Schema.String,
	message: Schema.String,
	errorUri: Schema.UndefinedOr(Schema.String),
}) {}

/** The issuer of an authorization server or response is not the one discovered (`undefined`: none). */
export class OAuthIssuerMismatchError extends Schema.TaggedError<OAuthIssuerMismatchError>()(
	"OAuthIssuerMismatchError",
	{ message: Schema.String, expected: Schema.UndefinedOr(Schema.String), received: Schema.UndefinedOr(Schema.String) },
) {}

/** Credentials would have gone to an endpoint that is not https (nor loopback); nothing was sent. */
export class OAuthInsecureEndpointError extends Schema.TaggedError<OAuthInsecureEndpointError>()(
	"OAuthInsecureEndpointError",
	{ message: Schema.String, endpoint: Schema.String },
) {}

/** Dynamic client registration failed with `status`. */
export class OAuthRegistrationError extends Schema.TaggedError<OAuthRegistrationError>()("OAuthRegistrationError", {
	message: Schema.String,
	status: Schema.Number,
	body: Schema.String,
}) {}

/** The user has to sign in (no tokens, a refresh that needs the browser, or a server asking for more scope). */
export class McpOAuthAuthorizationRequiredError extends Schema.TaggedError<McpOAuthAuthorizationRequiredError>()(
	"McpOAuthAuthorizationRequiredError",
	{ message: Schema.String },
) {}

/** Another process held a store's refresh lock for the whole wait. A store's `withRefreshLock` fails with it. */
export class McpRefreshLockBusyError extends Schema.TaggedError<McpRefreshLockBusyError>()("McpRefreshLockBusyError", {
	message: Schema.String,
}) {}

/** The user gave a sign-in up (an empty pasted redirect URL), or Pi cancelled it. */
export class McpSignInCancelledError extends Schema.TaggedError<McpSignInCancelledError>()("McpSignInCancelledError", {
	message: Schema.String,
}) {}

/** pi-mcp rejected with an error it has no class for: a process that cannot start, a refused connection, a bad URL. */
export class McpUnexpectedError extends Schema.TaggedError<McpUnexpectedError>()("McpUnexpectedError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/** Every failure of a call into pi-mcp. */
export type McpFailure =
	| McpError
	| McpConnectionClosedError
	| McpTimeoutError
	| McpAbortError
	| McpHttpError
	| McpAuthRequiredError
	| McpSessionExpiredError
	| OAuthError
	| OAuthIssuerMismatchError
	| OAuthInsecureEndpointError
	| OAuthRegistrationError
	| McpOAuthAuthorizationRequiredError
	| McpRefreshLockBusyError
	| McpSignInCancelledError
	| McpUnexpectedError;

/** What a pi-mcp promise rejected with, or a pi-mcp function threw, as an `McpFailure`. */
export function fromPi(cause: unknown): McpFailure {
	for (const tag of TAGS) {
		const tagged = tag(cause);
		if (tagged !== undefined) return tagged;
	}
	return new McpUnexpectedError({ cause });
}

/**
 * The names of the Pi error classes `fromPi` gives a tag of their own. `test/pi-conformance.ts` holds them equal to
 * the error classes pi-mcp and its OAuth subpath export, so a class Pi adds fails to compile until it has a tag.
 */
export type TaggedClass = keyof typeof BY_CLASS;

/** The tag of `cause` when it is an instance of one Pi error class, else nothing. */
type Tag = (cause: unknown) => McpFailure | undefined;

// One entry per error class of Pi, keyed by its exported name. Subclasses come before the class they extend.
const BY_CLASS = {
	McpAuthRequiredError: tag(
		PiMcpAuthRequiredError,
		(error) =>
			new McpAuthRequiredError({
				status: error.status,
				message: error.message,
				body: error.body,
				wwwAuthenticate: error.wwwAuthenticate,
			}),
	),
	McpSessionExpiredError: tag(
		PiMcpSessionExpiredError,
		(error) => new McpSessionExpiredError({ message: error.message, body: error.body }),
	),
	McpHttpError: tag(
		PiMcpHttpError,
		(error) => new McpHttpError({ status: error.status, message: error.message, body: error.body }),
	),
	McpError: tag(PiMcpError, (error) => new McpError({ code: error.code, message: error.message, data: error.data })),
	McpConnectionClosedError: tag(
		PiMcpConnectionClosedError,
		(error) => new McpConnectionClosedError({ message: error.message }),
	),
	McpTimeoutError: tag(PiMcpTimeoutError, (error) => new McpTimeoutError({ timeoutMs: error.timeoutMs })),
	McpAbortError: tag(PiMcpAbortError, (error) => new McpAbortError({ message: error.message })),
	OAuthError: tag(
		PiOAuthError,
		(error) => new OAuthError({ code: error.code, message: error.message, errorUri: error.errorUri }),
	),
	OAuthIssuerMismatchError: tag(
		PiOAuthIssuerMismatchError,
		(error) =>
			new OAuthIssuerMismatchError({ message: error.message, expected: error.expected, received: error.received }),
	),
	OAuthInsecureEndpointError: tag(
		PiOAuthInsecureEndpointError,
		(error) => new OAuthInsecureEndpointError({ message: error.message, endpoint: error.endpoint }),
	),
	OAuthRegistrationError: tag(
		PiOAuthRegistrationError,
		(error) => new OAuthRegistrationError({ message: error.message, status: error.status, body: error.body }),
	),
	McpOAuthAuthorizationRequiredError: tag(
		PiMcpOAuthAuthorizationRequiredError,
		(error) => new McpOAuthAuthorizationRequiredError({ message: error.message }),
	),
	McpRefreshLockBusyError: tag(
		PiMcpRefreshLockBusyError,
		(error) => new McpRefreshLockBusyError({ message: error.message }),
	),
	McpSignInCancelledError: tag(
		PiMcpSignInCancelledError,
		(error) => new McpSignInCancelledError({ message: error.message }),
	),
};

const TAGS: ReadonlyArray<Tag> = Object.values(BY_CLASS);

/** The tag `make` gives an instance of `piClass`. */
function tag<E extends Error>(piClass: abstract new (...args: never[]) => E, make: (error: E) => McpFailure): Tag {
	return (cause) => (cause instanceof piClass ? make(cause) : undefined);
}

/**
 * The Pi error an Effect this package hands to Pi (a store, an auth provider, a request handler) failed with, so that
 * Pi's own checks (`instanceof McpRefreshLockBusyError`, an `McpError`'s code in a response) see what they expect.
 */
export function toPi(failure: McpFailure): Error {
	switch (failure._tag) {
		case "McpError":
			return new PiMcpError(failure.code, failure.message, failure.data);
		case "McpConnectionClosedError":
			return new PiMcpConnectionClosedError(failure.message);
		case "McpTimeoutError":
			return new PiMcpTimeoutError(failure.timeoutMs);
		case "McpAbortError":
			return new PiMcpAbortError(failure.message);
		case "McpHttpError":
			return new PiMcpHttpError(failure.status, failure.message, failure.body);
		case "McpAuthRequiredError": {
			// Pi's class reads its challenge from the response it was given.
			const headers: Record<string, string> =
				failure.wwwAuthenticate === null ? {} : { "www-authenticate": failure.wwwAuthenticate };
			return new PiMcpAuthRequiredError(new Response(null, { status: 401, headers }), failure.body);
		}
		case "McpSessionExpiredError":
			return new PiMcpSessionExpiredError(failure.body);
		case "OAuthError":
			return new PiOAuthError(failure.code, failure.message, failure.errorUri);
		case "OAuthIssuerMismatchError":
			return new PiOAuthIssuerMismatchError(failure.expected, failure.received);
		case "OAuthInsecureEndpointError":
			return new PiOAuthInsecureEndpointError(failure.endpoint);
		case "OAuthRegistrationError":
			return new PiOAuthRegistrationError(failure.status, failure.body);
		case "McpOAuthAuthorizationRequiredError":
			return new PiMcpOAuthAuthorizationRequiredError();
		case "McpRefreshLockBusyError":
			return new PiMcpRefreshLockBusyError();
		case "McpSignInCancelledError":
			return new PiMcpSignInCancelledError();
		case "McpUnexpectedError":
			return Predicate.isError(failure.cause) ? failure.cause : new Error(String(failure.cause));
	}
}
