# @effectified/pi-mcp

Pi's Model Context Protocol client ([`@earendil-works/pi-mcp`](../mcp)) in Effect terms, for `effect` 4.1:

- `McpClient`, a connection to an MCP server, as a scoped resource and as a service with a Layer. Its calls are
  Effects: interrupting the fiber cancels the request on the server, and the timeout runs on `Clock`.
- The transports (stdio, Streamable HTTP, a pipe to a program something else runs) as scoped resources.
- Notifications and the errors the client reports as `Stream`s; the server's own requests answered by Effects.
- pi-mcp's error classes, and those of its OAuth subpath, as one union of tagged errors, `McpFailure`.
- OAuth sign-in and authenticated connections in `@effectified/pi-mcp/oauth`, with the token store given as Effects.
- pi-mcp's in-memory transport pair in `@effectified/pi-mcp/testing`, for tests without a server process.

It adds no behaviour of its own: what pi-mcp does is what happens. Built for pi-mcp 1.6.1.

## Install

```sh
# the pi-effect packages come from their GitHub release, not npm
R=https://github.com/effectified/pi/releases/download/v0.1.0
npm install --allow-remote=all $R/effectified-pi-mcp-0.1.0.tgz effect
```

`effect` is a peer dependency (`~4.1.5`), so the application has one copy.

## Quick start

A server that speaks MCP over stdio, started for the scope. Closing the scope closes the client and ends the
process as pi-mcp does: stdin closed, then SIGTERM, then SIGKILL.

```typescript
import { Effect } from "effect";
import { McpClient, stdioTransport } from "@effectified/pi-mcp";

const echoOnce = (command: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const transport = yield* stdioTransport({ command, args });
		const client = yield* McpClient.connect(transport, { name: "my-app", version: "1.0.0" });
		const tools = yield* client.listTools();
		const result = yield* client.callTool("echo", { text: "hello" });
		return { server: client.initialize.serverInfo.name, tools: tools.map((tool) => tool.name), result };
	});

const answer = await Effect.runPromise(Effect.scoped(echoOnce("node", ["server.mjs"])));
```

`client.initialize` is the server's answer to `initialize`: protocol version, capabilities, server info and
instructions. Every call (`request`, `notify`, `ping`, `listTools`, `listResources`, `listResourcesPage`,
`listResourceTemplates`, `listResourceTemplatesPage`, `readResource`, `callTool`) is an Effect that fails with an
`McpFailure`. A tool that failed is a result with `isError`, not a failure.

## The client as a service

`McpClient.layer` connects for as long as the Layer lives. The transport is an Effect, so the Layer owns it too.

```typescript
import { Effect } from "effect";
import { McpClient, stdioTransport } from "@effectified/pi-mcp";

const McpLive = (command: string, args: ReadonlyArray<string>) =>
	McpClient.layer(stdioTransport({ command, args }), { name: "my-app", version: "1.0.0" });

const toolNames = Effect.gen(function* () {
	const client = yield* McpClient;
	return (yield* client.listTools()).map((tool) => tool.name);
});

const names = await Effect.runPromise(toolNames.pipe(Effect.provide(McpLive("node", ["server.mjs"]))));
```

`streamableHttpTransport({ url })` reaches a server over Streamable HTTP; its `auth` takes the bearer tokens (see
[OAuth](#oauth)). `pipeTransport({ open })` speaks MCP's stdio framing over a program the application runs itself,
on another machine or in a sandbox: `open` is an Effect that starts it and gives its stdin and its end.

## Timeouts, progress and errors

A request fails with `McpTimeoutError` when the server neither answers nor reports progress for its `timeout`
(default: the client's `requestTimeout`, 30 seconds as in Pi). Each progress notification starts the timeout again
and goes to the request's `progress` queue. The deadline is kept on `Clock`, so `TestClock` drives it. A timeout or
an interruption cancels the request on the server, as Pi does.

```typescript
import { Effect, Queue } from "effect";
import type { McpClientService, ProgressNotification } from "@effectified/pi-mcp";

const search = (client: McpClientService, query: string) =>
	Effect.gen(function* () {
		const progress = yield* Queue.unbounded<ProgressNotification>();
		const result = yield* client.callTool("search", { query }, { timeout: "2 minutes", progress });
		// What the server reported while it worked.
		const reports = yield* Queue.clear(progress);
		return { result, reports };
	}).pipe(Effect.catchTag("McpTimeoutError", () => Effect.succeed({ result: undefined, reports: [] })));
```

`McpFailure` is closed: one tag per error class of pi-mcp (`McpError`, `McpConnectionClosedError`, `McpTimeoutError`,
`McpHttpError`, `McpAuthRequiredError`, `McpSessionExpiredError`, the OAuth ones), and `McpUnexpectedError` for what
pi-mcp throws without a class of its own, such as a command that cannot start.

## Notifications and the server's requests

`client.notifications(method)` streams the `params` of each notification from when the Stream starts, and ends
when the connection closes. `client.errors` does the same for what the client reports without failing a call.
`client.handle(method, handler)` answers the server's requests (`sampling/createMessage`, `elicitation/create`)
until its scope closes; a server's cancellation interrupts the handler, and an `McpError` is the error response.

```typescript
import { Effect, Stream } from "effect";
import type { McpClientService } from "@effectified/pi-mcp";

const toolsOnChange = (client: McpClientService) =>
	client.notifications("notifications/tools/list_changed").pipe(Stream.mapEffect(() => client.listTools()));

const answerSampling = (client: McpClientService) =>
	client.handle("sampling/createMessage", () =>
		Effect.succeed({ role: "assistant", content: { type: "text", text: "no model here" }, model: "none" }),
	);
```

## Results for a model

pi-mcp's conversion of a tool result into what a model reads, with the place to save what it cannot read inline
(binary resources, the full text of a long result) as an Effect.

```typescript
import { Effect } from "effect";
import { limitMcpContent, type McpClientService, type OutputSaver, toMcpModelContent } from "@effectified/pi-mcp";

const forModel = (client: McpClientService, saveOutput: OutputSaver) =>
	Effect.gen(function* () {
		const result = yield* client.callTool("fetch", { url: "https://example.com" });
		const content = yield* toMcpModelContent("web", result, { saveOutput, readResourceTool: "read_mcp_resource" });
		return yield* limitMcpContent(content, saveOutput);
	});
```

pi-mcp's pure helpers come as they are: `createMcpToolName`, `mcpNamespace`, `mcpServerSummary`,
`normalizeMcpInputSchema`, `createMcpResultSchema`, `toLlmContent`, `validateMcpServerConfig`,
`isMcpServerOverride`, the JSON-RPC guards and the protocol constants.

## OAuth

`@effectified/pi-mcp/oauth` signs in to an OAuth-protected server and authenticates its connections. The token store
is an `OAuthStore` of Effects (`load`, `save`, `withRefreshLock`); `memoryOAuthStore()` is pi-mcp's memory store for
one process.

```typescript
import { Effect } from "effect";
import { McpClient, streamableHttpTransport } from "@effectified/pi-mcp";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	type OAuthStore,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "@effectified/pi-mcp/oauth";

const signIn = (serverUrl: string, store: OAuthStore, openBrowser: (url: string) => Effect.Effect<void>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const loopback = yield* listenForLoopbackSignIn({ serverUrl, store, settings: {} });
			const options = { serverUrl, store, settings: {}, redirectUrl: loopback.redirectUrl, clientName: "my-app" };
			const started = yield* startMcpSignIn(options);
			if (started.kind === "authorized") return;
			yield* openBrowser(started.authorizationUrl);
			const response = yield* waitForLoopbackSignIn({ callback: loopback.callback, authorization: started });
			yield* completeMcpSignIn({ ...options, authorization: started, response });
		}),
	);

const connectSignedIn = (serverUrl: string, store: OAuthStore) =>
	Effect.gen(function* () {
		const auth = yield* createMcpAuthProvider({
			serverUrl,
			store,
			clientName: "my-app",
			settings: Effect.succeed({}),
		});
		const transport = yield* streamableHttpTransport({ url: serverUrl, auth });
		return yield* McpClient.connect(transport, { name: "my-app", version: "1.0.0" });
	});
```

The auth provider sends the stored access token and refreshes it; when the user has to sign in, the connection fails
with `McpOAuthAuthorizationRequiredError`, and its `challenges` queue has the server's challenge for the sign-in.
Closing its scope waits for a refresh in flight. The two halves of a sign-in can run in different requests of a web
application with the same store. Discovery (`discoverOAuthServerInfo`, ...) and the single requests of the flow
(`registerClient`, `exchangeAuthorizationCode`, `refreshAuthorization`, `authorizeMcp`, ...) are Effects too.

## Testing

`inMemoryTransportPair()` links a client transport to a peer the test plays the server on: the client's messages
arrive as a Stream, and the peer's `send` delivers to the client.

```typescript
import { Effect, Stream } from "effect";
import { isJsonRpcRequest, LATEST_PROTOCOL_VERSION, McpClient } from "@effectified/pi-mcp";
import { inMemoryTransportPair } from "@effectified/pi-mcp/testing";

const pingInMemory = Effect.gen(function* () {
	const { client, server } = yield* inMemoryTransportPair();
	const serverInfo = { name: "fake", version: "1.0.0" };
	const initialized = { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo };
	yield* Effect.forkScoped(
		Stream.runForEach(server.messages, (message) =>
			isJsonRpcRequest(message)
				? server.send({
						jsonrpc: "2.0",
						id: message.id,
						result: message.method === "initialize" ? initialized : {},
					})
				: Effect.void,
		),
	);
	const connected = yield* McpClient.connect(client, { name: "test", version: "1.0.0" });
	yield* connected.ping();
	return connected.initialize.serverInfo;
});
```

Run it with `runTest` of `@effectified/pi-ai/testing`, or in `Effect.scoped`.

## Timers that stay Pi's

The request deadline runs on `Clock`. Timers inside pi-mcp's transports and OAuth code still run on the real clock:
the stdio and pipe shutdown grace periods (`closeTimeoutMs`), the Streamable HTTP reconnection backoff and the
one-second session close, the OAuth callback server's wait (`timeoutMs`, five minutes) and the 15-second limit of each
request to an authorization server.

## License

MIT
