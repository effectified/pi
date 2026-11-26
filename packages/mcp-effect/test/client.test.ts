// The client against a scripted server over pi-mcp's in-memory pair: calls as Effects, the timeout on the test clock,
// interruption as cancellation, notifications and reported errors as Streams, server requests answered by Effects.

import type { ProgressNotification } from "@earendil-works/pi-mcp";
import { runTest } from "@effectified/pi-ai/testing";
import { Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { McpClient, McpError } from "../src/index.ts";
import { inMemoryTransportPair } from "../src/testing/index.ts";
import { INITIALIZED, serve } from "./server.ts";

const CLIENT = { name: "test-client", version: "1.0.0" };

const echo = {
	"tools/list": () => Effect.succeed({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
	"tools/call": (request: { params?: unknown }) =>
		Effect.succeed({ content: [{ type: "text", text: JSON.stringify(request.params) }] }),
};

describe("McpClient.connect", () => {
	it("initializes the session and lifts Pi's calls into Effects", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, echo);
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const tools = yield* client.listTools();
				const result = yield* client.callTool("echo", { text: "hi" });
				return { initialize: client.initialize, tools, result };
			}),
		);
		expect(seen.initialize).toEqual(INITIALIZED);
		expect(seen.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(seen.result.content).toEqual([{ type: "text", text: '{"name":"echo","arguments":{"text":"hi"}}' }]);
	});

	it("fails with McpError when the server answers with an error", async () => {
		const error = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, {
					"tools/call": () =>
						Effect.fail(new McpError({ code: -32602, message: "bad arguments", data: { at: "text" } })),
				});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				return yield* Effect.flip(client.callTool("echo"));
			}),
		);
		expect(error).toMatchObject({ _tag: "McpError", code: -32602, message: "bad arguments", data: { at: "text" } });
	});

	it("fails a connection the server never answers on the clock, and closes the client", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, { initialize: () => Effect.never });
				const connecting = yield* Effect.forkChild(Effect.flip(McpClient.connect(pair.client, CLIENT)), {
					startImmediately: true,
				});
				yield* TestClock.adjust("30 seconds");
				const error = yield* Fiber.join(connecting);
				// The client closed its transport, so the server's end has closed too.
				const ended = yield* Effect.exit(pair.server.send({ jsonrpc: "2.0", method: "late" }));
				return { error, ended };
			}),
		);
		expect(seen.error).toMatchObject({ _tag: "McpTimeoutError", timeoutMs: 30_000 });
		expect(Exit.isFailure(seen.ended)).toBe(true);
	});
});

describe("a request's timeout", () => {
	it("fails on the clock with McpTimeoutError and cancels the request with Pi's reason", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const server = yield* serve(pair.server, { "tools/call": () => Effect.never });
				const client = yield* McpClient.connect(pair.client, { ...CLIENT, requestTimeout: "5 seconds" });
				const calling = yield* Effect.forkChild(Effect.flip(client.callTool("slow")), { startImmediately: true });
				yield* TestClock.adjust("5 seconds");
				const error = yield* Fiber.join(calling);
				const cancelled = yield* takeUntil(server.notifications, "notifications/cancelled");
				return { error, cancelled };
			}),
		);
		expect(seen.error).toMatchObject({ _tag: "McpTimeoutError", timeoutMs: 5_000 });
		expect(seen.cancelled.params).toEqual({ requestId: 2, reason: "Request timed out" });
	});

	it("starts again on each progress notification, which reaches the caller's queue", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const release = yield* Deferred.make<void>();
				const server = yield* serve(pair.server, {
					"tools/call": () => Effect.as(Deferred.await(release), { content: [{ type: "text", text: "done" }] }),
				});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const progress = yield* Queue.unbounded<ProgressNotification>();
				const calling = yield* Effect.forkChild(client.callTool("slow", {}, { timeout: "10 seconds", progress }), {
					startImmediately: true,
				});
				const call = yield* Queue.take(server.requests).pipe(
					Effect.repeat({ until: (r) => r.method === "tools/call" }),
				);
				const token = (call.params as { _meta: { progressToken: number } })._meta.progressToken;
				yield* TestClock.adjust("8 seconds");
				yield* server.notify("notifications/progress", { progressToken: token, progress: 1, total: 2 });
				const reported = yield* Queue.take(progress);
				// 16 seconds since the call, 8 since its progress: within the timeout only because progress restarted it.
				yield* TestClock.adjust("8 seconds");
				yield* Deferred.succeed(release, undefined);
				const result = yield* Fiber.join(calling);
				return { reported, result };
			}),
		);
		expect(seen.reported).toEqual({ progressToken: 2, progress: 1, total: 2 });
		expect(seen.result.content).toEqual([{ type: "text", text: "done" }]);
	});

	it("never ends a request with an infinite timeout", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const release = yield* Deferred.make<void>();
				yield* serve(pair.server, { ping: () => Effect.as(Deferred.await(release), {}) });
				const client = yield* McpClient.connect(pair.client, { ...CLIENT, requestTimeout: "Infinity" });
				const pinging = yield* Effect.forkChild(client.ping(), { startImmediately: true });
				yield* TestClock.adjust("1 day");
				yield* Deferred.succeed(release, undefined);
				return yield* Effect.exit(Fiber.join(pinging));
			}),
		);
		expect(Exit.isSuccess(result)).toBe(true);
	});
});

describe("interruption", () => {
	it("cancels the request on the server when the calling fiber is interrupted", async () => {
		const cancelled = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const server = yield* serve(pair.server, { "tools/call": () => Effect.never });
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const calling = yield* Effect.forkChild(client.callTool("slow"), { startImmediately: true });
				yield* Queue.take(server.requests).pipe(Effect.repeat({ until: (r) => r.method === "tools/call" }));
				yield* Fiber.interrupt(calling);
				return yield* takeUntil(server.notifications, "notifications/cancelled");
			}),
		);
		expect(cancelled.params).toMatchObject({ requestId: 2 });
	});
});

describe("notifications and errors", () => {
	it("streams the server's notifications of one method from when the Stream starts", async () => {
		const received = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const server = yield* serve(pair.server, {});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const changes = yield* Effect.forkChild(
					Stream.runCollect(Stream.take(client.notifications("notifications/tools/list_changed"), 2)),
					{ startImmediately: true },
				);
				yield* server.notify("notifications/resources/list_changed", { other: true });
				yield* server.notify("notifications/tools/list_changed", { first: true });
				yield* server.notify("notifications/tools/list_changed");
				return yield* Fiber.join(changes);
			}),
		);
		expect(received).toEqual([{ first: true }, undefined]);
	});

	it("streams what the client reports without failing a call, as tagged errors", async () => {
		const reported = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, {});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const errors = yield* Effect.forkChild(Stream.runHead(client.errors), { startImmediately: true });
				pair.client.emitError(new Error("socket reset"));
				return yield* Fiber.join(errors);
			}),
		);
		expect(reported).toMatchObject({ _tag: "Some", value: { _tag: "McpUnexpectedError", message: "socket reset" } });
	});

	it("ends the Streams and completes `closed` when the transport drops; calls then fail as closed", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, {});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const notifications = yield* Effect.forkChild(Stream.runCollect(client.notifications("x")), {
					startImmediately: true,
				});
				yield* Effect.promise(() => pair.client.close());
				yield* client.closed;
				const collected = yield* Fiber.join(notifications);
				const error = yield* Effect.flip(client.ping());
				const late = yield* Stream.runCollect(client.errors);
				return { collected, error, late };
			}),
		);
		expect(seen).toMatchObject({ collected: [], error: { _tag: "McpConnectionClosedError" }, late: [] });
	});
});

describe("requests from the server", () => {
	it("answers them with an Effect while its scope is open, then no longer", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const server = yield* serve(pair.server, {});
				const client = yield* McpClient.connect(pair.client, CLIENT);
				const answered = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* client.handle("sampling/createMessage", (params) => Effect.succeed({ echoed: params }));
						yield* client.handle("elicitation/create", () =>
							Effect.fail(new McpError({ code: -32001, message: "declined", data: undefined })),
						);
						return [
							yield* server.request("sampling/createMessage", { prompt: "hi" }),
							yield* server.request("elicitation/create"),
						];
					}),
				);
				const after = yield* server.request("sampling/createMessage");
				return { answered, after };
			}),
		);
		expect(seen.answered[0]).toMatchObject({ result: { echoed: { prompt: "hi" } } });
		expect(seen.answered[1]).toMatchObject({ error: { code: -32001, message: "declined" } });
		expect(seen.after).toMatchObject({ error: { code: -32601 } });
	});

	it("answers roots/list from the roots Effect, and declares the capability", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				const server = yield* serve(pair.server, {});
				yield* McpClient.connect(pair.client, {
					...CLIENT,
					roots: Effect.succeed([{ uri: "file:///work", name: "work" }]),
				});
				const initialize = yield* Queue.take(server.requests);
				const roots = yield* server.request("roots/list");
				return { initialize, roots };
			}),
		);
		expect(seen.initialize.params).toMatchObject({ capabilities: { roots: {} }, clientInfo: CLIENT });
		expect(seen.roots).toMatchObject({ result: { roots: [{ uri: "file:///work", name: "work" }] } });
	});
});

describe("McpClient.layer", () => {
	it("provides a connected client for the layer's life and closes it with the layer", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const pair = yield* inMemoryTransportPair();
				yield* serve(pair.server, echo);
				const tools = yield* Effect.gen(function* () {
					const client = yield* McpClient;
					return yield* client.listTools();
				}).pipe(Effect.provide(McpClient.layer(Effect.succeed(pair.client), CLIENT)));
				const ended = yield* Effect.exit(pair.server.send({ jsonrpc: "2.0", method: "late" }));
				return { tools, ended };
			}),
		);
		expect(seen.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(Exit.isFailure(seen.ended)).toBe(true);
	});
});

/** The next item of `queue` whose method is `method`. */
function takeUntil<A extends { readonly method: string }>(queue: Queue.Dequeue<A>, method: string): Effect.Effect<A> {
	return Queue.take(queue).pipe(Effect.repeat({ until: (item) => item.method === method }));
}
