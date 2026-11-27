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
import { Array as Arr, Option, Predicate, Record, Schema } from "effect";

/** A JSON-RPC error: the server answered a request with `code` and `message`, or a message was not valid JSON-RPC. */
export class McpError extends Schema.TaggedError<McpError, { readonly brand: unique symbol }>()("McpError", {
	// JSON-RPC codes are integers, but the server writes them: any JSON number is kept as it came.
	code: Schema.Finite,
	message: Schema.String,
	data: Schema.Unknown,
}) {}

/** The connection closed, or was never open, while the call needed it. */
export class McpConnectionClosedError extends Schema.TaggedError<
	McpConnectionClosedError,
	{ readonly brand: unique symbol }
>()("McpConnectionClosedError", { message: Schema.String }) {}

/** The server neither answered nor reported progress for `timeoutMs` milliseconds. */
export class McpTimeoutError extends Schema.TaggedError<McpTimeoutError, { readonly brand: unique symbol }>()(
	"McpTimeoutError",
	{ timeoutMs: Schema.Finite },
) {
	override get message(): string {
		return `MCP request timed out after ${this.timeoutMs}ms`;
	}
}

/**
 * Pi gave a request up because its signal was aborted. The calls of this package own that signal: interrupting the
 * calling fiber cancels the request as interruption, never as this error.
 */
export class McpAbortError extends Schema.TaggedError<McpAbortError, { readonly brand: unique symbol }>()(
	"McpAbortError",
	{ message: Schema.String },
) {}

/** An MCP HTTP request failed with `status`; `body` is the start of the response body. */
export class McpHttpError extends Schema.TaggedError<McpHttpError, { readonly brand: unique symbol }>()(
	"McpHttpError",
	{ status: Schema.Int, message: Schema.String, body: Schema.String },
) {}

/** The MCP server answered 401, or 403 asking for more scope; `wwwAuthenticate` is its challenge. */
export class McpAuthRequiredError extends Schema.TaggedError<McpAuthRequiredError, { readonly brand: unique symbol }>()(
	"McpAuthRequiredError",
	{
		status: Schema.Int,
		message: Schema.String,
		body: Schema.String,
		wwwAuthenticate: Schema.NullOr(Schema.String),
	},
) {}

/** The MCP server no longer knows the session (404 to a request that carried a session id). */
export class McpSessionExpiredError extends Schema.TaggedError<
	McpSessionExpiredError,
	{ readonly brand: unique symbol }
>()("McpSessionExpiredError", { message: Schema.String, body: Schema.String }) {}

/** An authorization server answered with the OAuth error `code`. */
export class OAuthError extends Schema.TaggedError<OAuthError, { readonly brand: unique symbol }>()("OAuthError", {
	code: Schema.String,
	message: Schema.String,
	errorUri: Schema.UndefinedOr(Schema.String),
}) {}

/** The issuer of an authorization server or response is not the one discovered (`undefined`: none). */
export class OAuthIssuerMismatchError extends Schema.TaggedError<
	OAuthIssuerMismatchError,
	{ readonly brand: unique symbol }
>()("OAuthIssuerMismatchError", {
	message: Schema.String,
	expected: Schema.UndefinedOr(Schema.String),
	received: Schema.UndefinedOr(Schema.String),
}) {}

/** Credentials would have gone to an endpoint that is not https (nor loopback); nothing was sent. */
export class OAuthInsecureEndpointError extends Schema.TaggedError<
	OAuthInsecureEndpointError,
	{ readonly brand: unique symbol }
>()("OAuthInsecureEndpointError", { message: Schema.String, endpoint: Schema.String }) {}

/** Dynamic client registration failed with `status`. */
export class OAuthRegistrationError extends Schema.TaggedError<
	OAuthRegistrationError,
	{ readonly brand: unique symbol }
>()("OAuthRegistrationError", { message: Schema.String, status: Schema.Int, body: Schema.String }) {}

/** The user has to sign in (no tokens, a refresh that needs the browser, or a server asking for more scope). */
export class McpOAuthAuthorizationRequiredError extends Schema.TaggedError<
	McpOAuthAuthorizationRequiredError,
	{ readonly brand: unique symbol }
>()("McpOAuthAuthorizationRequiredError", { message: Schema.String }) {}

/** Another process held a store's refresh lock for the whole wait. A store's `withRefreshLock` fails with it. */
export class McpRefreshLockBusyError extends Schema.TaggedError<
	McpRefreshLockBusyError,
	{ readonly brand: unique symbol }
>()("McpRefreshLockBusyError", { message: Schema.String }) {}

/** The user gave a sign-in up (an empty pasted redirect URL), or Pi cancelled it. */
export class McpSignInCancelledError extends Schema.TaggedError<
	McpSignInCancelledError,
	{ readonly brand: unique symbol }
>()("McpSignInCancelledError", { message: Schema.String }) {}

/** pi-mcp rejected with an error it has no class for: a process that cannot start, a refused connection, a bad URL. */
export class McpUnexpectedError extends Schema.TaggedError<McpUnexpectedError, { readonly brand: unique symbol }>()(
	"McpUnexpectedError",
	{ cause: Schema.Defect() },
) {
	override get message(): string {
		return Predicate.isError(this.cause) ? this.cause.message : String(this.cause);
	}
}

/**
 * Every failure of a call into pi-mcp, as one closed union. `McpFailure.match` picks a handler per tag and
 * `McpFailure.guards` tests for one.
 */
export const McpFailure = Schema.Union([
	McpError,
	McpConnectionClosedError,
	McpTimeoutError,
	McpAbortError,
	McpHttpError,
	McpAuthRequiredError,
	McpSessionExpiredError,
	OAuthError,
	OAuthIssuerMismatchError,
	OAuthInsecureEndpointError,
	OAuthRegistrationError,
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	McpSignInCancelledError,
	McpUnexpectedError,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure of a call into pi-mcp. */
export type McpFailure = typeof McpFailure.Type;

/** What a pi-mcp promise rejected with, or a pi-mcp function threw, as an `McpFailure`. */
export function fromPi(cause: unknown): McpFailure {
	return Option.getOrElse(
		Arr.findFirst(TAGS, (tag) => tag(cause)),
		() => McpUnexpectedError.make({ cause }),
	);
}

/**
 * The names of the Pi error classes `fromPi` gives a tag of their own. `test/pi-conformance.ts` holds them equal to
 * the error classes pi-mcp and its OAuth subpath export, so a class Pi adds fails to compile until it has a tag.
 */
export type TaggedClass = keyof typeof BY_CLASS;

/** The tag of `cause` when it is an instance of one Pi error class, else none. */
type Tag = (cause: unknown) => Option.Option<McpFailure>;

// One entry per error class of Pi, keyed by its exported name. Subclasses come before the class they extend.
const BY_CLASS = {
	McpAuthRequiredError: tag(PiMcpAuthRequiredError, (error) =>
		McpAuthRequiredError.make({
			status: error.status,
			message: error.message,
			body: error.body,
			wwwAuthenticate: error.wwwAuthenticate,
		}),
	),
	McpSessionExpiredError: tag(PiMcpSessionExpiredError, (error) =>
		McpSessionExpiredError.make({ message: error.message, body: error.body }),
	),
	McpHttpError: tag(PiMcpHttpError, (error) =>
		McpHttpError.make({ status: error.status, message: error.message, body: error.body }),
	),
	McpError: tag(PiMcpError, (error) => McpError.make({ code: error.code, message: error.message, data: error.data })),
	McpConnectionClosedError: tag(PiMcpConnectionClosedError, (error) =>
		McpConnectionClosedError.make({ message: error.message }),
	),
	McpTimeoutError: tag(PiMcpTimeoutError, (error) => McpTimeoutError.make({ timeoutMs: error.timeoutMs })),
	McpAbortError: tag(PiMcpAbortError, (error) => McpAbortError.make({ message: error.message })),
	OAuthError: tag(PiOAuthError, (error) =>
		OAuthError.make({ code: error.code, message: error.message, errorUri: error.errorUri }),
	),
	OAuthIssuerMismatchError: tag(PiOAuthIssuerMismatchError, (error) =>
		OAuthIssuerMismatchError.make({ message: error.message, expected: error.expected, received: error.received }),
	),
	OAuthInsecureEndpointError: tag(PiOAuthInsecureEndpointError, (error) =>
		OAuthInsecureEndpointError.make({ message: error.message, endpoint: error.endpoint }),
	),
	OAuthRegistrationError: tag(PiOAuthRegistrationError, (error) =>
		OAuthRegistrationError.make({ message: error.message, status: error.status, body: error.body }),
	),
	McpOAuthAuthorizationRequiredError: tag(PiMcpOAuthAuthorizationRequiredError, (error) =>
		McpOAuthAuthorizationRequiredError.make({ message: error.message }),
	),
	McpRefreshLockBusyError: tag(PiMcpRefreshLockBusyError, (error) =>
		McpRefreshLockBusyError.make({ message: error.message }),
	),
	McpSignInCancelledError: tag(PiMcpSignInCancelledError, (error) =>
		McpSignInCancelledError.make({ message: error.message }),
	),
};

const TAGS: ReadonlyArray<Tag> = Record.values(BY_CLASS);

/** The tag `make` gives an instance of `piClass`. */
function tag<E extends Error>(piClass: abstract new (...args: never[]) => E, make: (error: E) => McpFailure): Tag {
	// Trust boundary: what Pi threw or rejected with is unknown.
	return (cause) => (cause instanceof piClass ? Option.some(make(cause)) : Option.none());
}

/**
 * The Pi error an Effect this package hands to Pi (a store, an auth provider, a request handler) failed with, so that
 * Pi's own checks (`instanceof McpRefreshLockBusyError`, an `McpError`'s code in a response) see what they expect.
 */
export function toPi(failure: McpFailure): Error {
	return McpFailure.match(failure, {
		McpError: (error) => new PiMcpError(error.code, error.message, error.data),
		McpConnectionClosedError: (error) => new PiMcpConnectionClosedError(error.message),
		McpTimeoutError: (error) => new PiMcpTimeoutError(error.timeoutMs),
		McpAbortError: (error) => new PiMcpAbortError(error.message),
		McpHttpError: (error) => new PiMcpHttpError(error.status, error.message, error.body),
		// Pi's class reads its challenge from the response it was given.
		McpAuthRequiredError: (error) =>
			new PiMcpAuthRequiredError(
				new Response(null, {
					status: 401,
					headers: error.wwwAuthenticate === null ? {} : { "www-authenticate": error.wwwAuthenticate },
				}),
				error.body,
			),
		McpSessionExpiredError: (error) => new PiMcpSessionExpiredError(error.body),
		OAuthError: (error) => new PiOAuthError(error.code, error.message, error.errorUri),
		OAuthIssuerMismatchError: (error) => new PiOAuthIssuerMismatchError(error.expected, error.received),
		OAuthInsecureEndpointError: (error) => new PiOAuthInsecureEndpointError(error.endpoint),
		OAuthRegistrationError: (error) => new PiOAuthRegistrationError(error.status, error.body),
		McpOAuthAuthorizationRequiredError: () => new PiMcpOAuthAuthorizationRequiredError(),
		McpRefreshLockBusyError: () => new PiMcpRefreshLockBusyError(),
		McpSignInCancelledError: () => new PiMcpSignInCancelledError(),
		McpUnexpectedError: (error): Error =>
			Predicate.isError(error.cause) ? error.cause : new Error(String(error.cause)),
	});
}
