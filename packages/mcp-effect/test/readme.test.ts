// The examples of README.md as tests. The code under each "README:" comment is the README's, line for line; only the
// imports differ (the README names the package, this file its sources), and each test runs the example against a local
// server: the stdio fixture, a scripted in-memory server, or a loopback authorization server.

import { fileURLToPath } from "node:url";
import { runLive, runTest } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Option, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	isJsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	limitMcpContent,
	MCP_OUTPUT_MAX_BYTES,
	McpClient,
	type McpClientService,
	McpServerName,
	McpToolName,
	type OutputSaver,
	type ProgressNotification,
	stdioTransport,
	streamableHttpTransport,
	toMcpModelContent,
} from "../src/index.ts";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	memoryOAuthStore,
	type OAuthStore,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "../src/oauth/index.ts";
import { inMemoryTransportPair } from "../src/testing/index.ts";
import { authorizationServer } from "./oauth/authorization-server.ts";
import { type Handler, serve } from "./server.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

// README: quick start
const echoOnce = (command: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const transport = yield* stdioTransport({ command, args });
		const client = yield* McpClient.connect(transport, { name: "my-app", version: "1.0.0" });
		const tools = yield* client.listTools();
		const result = yield* client.callTool(McpToolName.make("echo"), { text: "hello" });
		return { server: client.initialize.serverInfo.name, tools: tools.map((tool) => tool.name), result };
	});

// README: the client as a service
const McpLive = (command: string, args: ReadonlyArray<string>) =>
	McpClient.layer(stdioTransport({ command, args }), { name: "my-app", version: "1.0.0" });

const toolNames = Effect.gen(function* () {
	const client = yield* McpClient;
	return (yield* client.listTools()).map((tool) => tool.name);
});

// README: timeouts, progress and errors
const search = (client: McpClientService, query: string) =>
	Effect.gen(function* () {
		const progress = yield* Queue.unbounded<ProgressNotification>();
		const result = yield* client.callTool(McpToolName.make("search"), { query }, { timeout: "2 minutes", progress });
		// What the server reported while it worked.
		const reports = yield* Queue.clear(progress);
		return { result, reports };
	}).pipe(Effect.catchTag("McpTimeoutError", () => Effect.succeed({ result: undefined, reports: [] })));

// README: notifications and the server's requests
const toolsOnChange = (client: McpClientService) =>
	client.notifications("notifications/tools/list_changed").pipe(Stream.mapEffect(() => client.listTools()));

const answerSampling = (client: McpClientService) =>
	client.handle("sampling/createMessage", () =>
		Effect.succeed({ role: "assistant", content: { type: "text", text: "no model here" }, model: "none" }),
	);

// README: results for a model
const forModel = (client: McpClientService, saveOutput: OutputSaver) =>
	Effect.gen(function* () {
		const result = yield* client.callTool(McpToolName.make("fetch"), { url: "https://example.com" });
		const options = { saveOutput, readResourceTool: "read_mcp_resource" };
		const content = yield* toMcpModelContent(McpServerName.make("web"), result, options);
		return yield* limitMcpContent(content, saveOutput);
	});

// README: OAuth
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

// README: testing
const pingInMemory = Effect.gen(function* () {
	const { client, server } = yield* inMemoryTransportPair;
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

/** A client connected to a scripted in-memory server with `handlers`. */
const scripted = (handlers: Record<string, Handler>) =>
	Effect.gen(function* () {
		const pair = yield* inMemoryTransportPair;
		const server = yield* serve(pair.server, handlers);
		const client = yield* McpClient.connect(pair.client, { name: "my-app", version: "1.0.0" });
		return { server, client };
	});

describe("the README", () => {
	it("quick start: a stdio server for the scope, listed and called", async () => {
		const answer = await runLive(Effect.scoped(echoOnce(process.execPath, [FIXTURE])));
		expect(answer).toEqual({
			server: "stdio-fixture",
			tools: ["echo"],
			result: { content: [{ type: "text", text: "hello" }] },
		});
	});

	it("the client as a service: a Layer that owns its transport", async () => {
		const names = await runLive(toolNames.pipe(Effect.provide(McpLive(process.execPath, [FIXTURE]))));
		expect(names).toEqual(["echo"]);
	});

	it("timeouts, progress and errors: progress reaches the queue, and a timeout is a value here", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair;
				yield* serve(pair.server, {
					"tools/call": (request) => {
						const params = request.params as { _meta: { progressToken: number }; arguments: { query: string } };
						const query = params.arguments.query;
						if (query === "slow") return Effect.never;
						return Effect.as(
							pair.server.send({
								jsonrpc: "2.0",
								method: "notifications/progress",
								params: { progressToken: params._meta.progressToken, progress: 1 },
							}),
							{ content: [{ type: "text", text: `found ${query}` }] },
						).pipe(Effect.orDie);
					},
				});
				const client = yield* McpClient.connect(pair.client, { name: "my-app", version: "1.0.0" });
				const found = yield* search(client, "effect");
				const slow = yield* Effect.forkChild(search(client, "slow"), { startImmediately: true });
				yield* TestClock.adjust("2 minutes");
				return { found, slow: yield* Fiber.join(slow) };
			}),
		);
		expect(seen.found).toEqual({
			result: { content: [{ type: "text", text: "found effect" }] },
			reports: [{ progressToken: 2, progress: 1 }],
		});
		expect(seen.slow).toEqual({ result: undefined, reports: [] });
	});

	it("notifications and the server's requests: a Stream of tool lists, and sampling answered", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const { server, client } = yield* scripted({
					"tools/list": () => Effect.succeed({ tools: [{ name: "new", inputSchema: { type: "object" } }] }),
				});
				const changes = yield* Effect.forkChild(Stream.runHead(toolsOnChange(client)), { startImmediately: true });
				yield* server.notify("notifications/tools/list_changed");
				const tools = yield* Fiber.join(changes);
				yield* answerSampling(client);
				const sampled = yield* server.request("sampling/createMessage", { messages: [] });
				return { tools, sampled };
			}),
		);
		expect(seen.tools).toMatchObject({ _tag: "Some", value: [{ name: "new" }] });
		expect(seen.sampled).toMatchObject({ result: { content: { text: "no model here" }, model: "none" } });
	});

	it("results for a model: a long text cut, its full text saved by the Effect", async () => {
		const saved: Array<string | Uint8Array> = [];
		const limited = await runTest(
			Effect.gen(function* () {
				const long = "a".repeat(MCP_OUTPUT_MAX_BYTES * 2);
				const { client } = yield* scripted({
					"tools/call": () => Effect.succeed({ content: [{ type: "text", text: long }] }),
				});
				return yield* forModel(client, (data, extension) =>
					Effect.sync(() => {
						saved.push(data);
						return `/tmp/full${extension}`;
					}),
				);
			}),
		);
		expect(limited.fullOutputPath).toBe("/tmp/full.txt");
		expect(saved).toHaveLength(1);
	});

	it("OAuth: signed in through the loopback callback, then connected with the stored token", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const server = yield* authorizationServer;
				const store = yield* memoryOAuthStore;
				// The "browser" follows the authorization server's redirect to the loopback callback.
				const openBrowser = (url: string) =>
					Effect.asVoid(Effect.forkDetach(Effect.promise(() => fetch(url).then((response) => response.text()))));
				yield* signIn(server.serverUrl, store, openBrowser);
				// Signed in already: the second sign-in refreshes and never opens the browser.
				yield* signIn(server.serverUrl, store, () => Effect.die("no browser expected"));
				const client = yield* connectSignedIn(server.serverUrl, store);
				return { server: client.initialize.serverInfo, tokens: Option.getOrUndefined(yield* store.load)?.tokens };
			}),
		);
		expect(seen.server).toEqual({ name: "protected", version: "1" });
		expect(seen.tokens).toMatchObject({ access_token: "access-2" });
	});

	it("testing: a client against a peer the test plays the server on", async () => {
		expect(await runTest(pingInMemory)).toEqual({ name: "fake", version: "1.0.0" });
	});
});
