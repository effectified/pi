// What mcp-effect restates of pi-mcp by hand, checked against pi-mcp's own types. Type-only: nothing here runs. A
// failure names what moved upstream.

import type * as PiMcp from "@earendil-works/pi-mcp";
import type {
	AuthProvider,
	McpClientOptions,
	McpPipe,
	McpRequestOptions,
	PipeTransportOptions,
	StdioTransportOptions,
	StreamableHttpTransportOptions,
} from "@earendil-works/pi-mcp";
import type * as PiOAuth from "@earendil-works/pi-mcp/oauth";
import type {
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	McpOAuthServerStore,
	McpSignInOptions,
	waitForLoopbackSignIn,
} from "@earendil-works/pi-mcp/oauth";
import type { Assert, Conform, Covers } from "../../../effect/conformance.ts";
import type { Auth } from "../src/auth.ts";
import type { ClientOptions, McpClientService } from "../src/client.ts";
import type * as Errors from "../src/errors.ts";
import type { TaggedClass } from "../src/errors.ts";
import type { AuthProviderOptions } from "../src/oauth/auth-provider.ts";
import type { LoopbackOptions, WaitOptions } from "../src/oauth/loopback.ts";
import type { SignInOptions } from "../src/oauth/sign-in.ts";
import type { OAuthStore } from "../src/oauth/store.ts";
import type { PiRequestOptions, RequestOptions } from "../src/request.ts";
import type { Pipe, PipeOptions, StdioOptions, StreamableHttpOptions } from "../src/transports.ts";

/** The names of the error classes a module exports. */
type ErrorClasses<M> = { [K in keyof M]: M[K] extends abstract new (...args: never[]) => Error ? K : never }[keyof M];

/**
 * `fromPi` tags exactly the error classes pi-mcp and its OAuth subpath export: a class Pi adds fails here until it
 * has a tag, so no Pi error ends as an `McpUnexpectedError` that a `catchTag` would miss.
 */
export type EveryErrorTagged = Assert<Conform<TaggedClass, ErrorClasses<typeof PiMcp> | ErrorClasses<typeof PiOAuth>>>;

/** The fields a Pi error class adds to `Error`. */
type Own<Pi> = Exclude<keyof Pi, keyof Error>;

/** Our tagged error carries every field Pi's class adds, with the same type. */
type Mirrors<Ours, Pi> = Conform<Pick<Ours, Own<Pi> & keyof Ours>, Pick<Pi, Own<Pi>>>;

/** Each tagged error mirrors its Pi class field by field; the tag of each is the class's name. */
export type ErrorFields = Assert<
	Mirrors<Errors.McpError, PiMcp.McpError> &
		Mirrors<Errors.McpTimeoutError, PiMcp.McpTimeoutError> &
		Mirrors<Errors.McpHttpError, PiMcp.McpHttpError> &
		Mirrors<Errors.McpAuthRequiredError, PiMcp.McpAuthRequiredError> &
		Mirrors<Errors.McpSessionExpiredError, PiMcp.McpSessionExpiredError> &
		Mirrors<Errors.OAuthError, PiOAuth.OAuthError> &
		Mirrors<Errors.OAuthIssuerMismatchError, PiOAuth.OAuthIssuerMismatchError> &
		Mirrors<Errors.OAuthInsecureEndpointError, PiOAuth.OAuthInsecureEndpointError> &
		Mirrors<Errors.OAuthRegistrationError, PiOAuth.OAuthRegistrationError>
>;

/** The tag of every member of the union is the name of the Pi class it stands for, or `McpUnexpectedError`. */
export type TagsAreClassNames = Assert<Conform<Errors.McpFailure["_tag"], TaggedClass | "McpUnexpectedError">>;

/**
 * Every member of Pi's client is an Effect of `McpClientService` or named here with what stands for it. A member Pi
 * adds fails here until it is wrapped or named.
 */
export type ClientCovered = Assert<
	Covers<
		PiMcp.McpClient,
		McpClientService,
		// `McpClient.connect` and the scope.
		| "connect"
		| "close"
		| "options"
		// Read from `initialize`, Pi's own answer to it, which does not change while connected.
		| "serverInfo"
		| "serverCapabilities"
		| "instructions"
		| "protocolVersion"
		// `closed`, the Streams and `handle`.
		| "connectionState"
		| "onClose"
		| "onError"
		| "onNotification"
		| "setRequestHandler"
	>
>;

/** A request's options: Pi's signal is the fiber, its timer `timeout`, its progress callback `progress`. */
export type RequestOptionsCovered = Assert<Conform<keyof McpRequestOptions, keyof PiRequestOptions>> &
	Assert<Conform<keyof RequestOptions, "timeout" | "progress">>;

/** The client's options are Pi's, its timeout a `Duration` and its roots an Effect. */
export type ClientOptionsCovered = Assert<Covers<McpClientOptions, ClientOptions, "requestTimeoutMs">>;

/** The transports' options are Pi's but for the callbacks and the auth provider each replaces. */
export type TransportOptionsCovered = Assert<Covers<StdioTransportOptions, StdioOptions, "onStderr">> &
	Assert<Covers<PipeTransportOptions, PipeOptions, "onStderr">> &
	Assert<Covers<StreamableHttpTransportOptions, StreamableHttpOptions, "authProvider">> &
	Assert<Covers<McpPipe, Pipe>> &
	Assert<Covers<AuthProvider, Auth>>;

/** The OAuth store and the options of what takes one are Pi's, with the store as Effects and the signal the fiber's. */
export type OAuthOptionsCovered = Assert<Covers<McpOAuthServerStore, OAuthStore>> &
	Assert<Covers<McpSignInOptions, SignInOptions, "signal">> &
	Assert<Covers<Parameters<typeof createMcpAuthProvider>[0], AuthProviderOptions, "onChallenge">> &
	Assert<Covers<Parameters<typeof listenForLoopbackSignIn>[0], LoopbackOptions>> &
	Assert<Covers<Parameters<typeof waitForLoopbackSignIn>[0], WaitOptions, "signal">>;
