// A scripted MCP server for the tests: the other end of an in-memory pair, answering the client's requests with
// Effects, recording its notifications, and sending requests and notifications of its own. A protocol peer, not a
// stand-in for any part of Pi.

import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	LATEST_PROTOCOL_VERSION,
} from "@earendil-works/pi-mcp";
import { Deferred, Effect, Queue, type Scope, Stream } from "effect";
import { McpError } from "../src/index.ts";
import type { Peer } from "../src/testing/index.ts";

/** Answers one request: its result, or an `McpError` for the error response. */
export type Handler = (request: JsonRpcRequest) => Effect.Effect<unknown, McpError>;

/** The running server. */
export interface Server {
	/** Every notification the client sent, in order. */
	readonly notifications: Queue.Dequeue<JsonRpcNotification>;
	/** Every request the client sent, in order, before it is answered. */
	readonly requests: Queue.Dequeue<JsonRpcRequest>;
	/** Sends a request to the client and waits for its response. */
	readonly request: (method: string, params?: Record<string, unknown>) => Effect.Effect<JsonRpcResponse, unknown>;
	/** Sends a notification to the client. */
	readonly notify: (method: string, params?: Record<string, unknown>) => Effect.Effect<void, unknown>;
}

/** The answer to `initialize` unless a test names its own. */
export const INITIALIZED = {
	protocolVersion: LATEST_PROTOCOL_VERSION,
	capabilities: { tools: { listChanged: true } },
	serverInfo: { name: "test-server", version: "1.0.0" },
	instructions: "Use test tools.",
};

/** Serves `handlers` (plus `initialize`) on `peer` until the scope closes; each request is answered on its own fiber. */
export function serve(peer: Peer, handlers: Record<string, Handler>): Effect.Effect<Server, never, Scope.Scope> {
	return Effect.gen(function* () {
		const notifications = yield* Queue.unbounded<JsonRpcNotification>();
		const requests = yield* Queue.unbounded<JsonRpcRequest>();
		const waiting = new Map<string | number, Deferred.Deferred<JsonRpcResponse>>();
		let nextId = 1;
		const answers: Record<string, Handler> = { initialize: () => Effect.succeed(INITIALIZED), ...handlers };
		const answer = (request: JsonRpcRequest) => {
			const handler = answers[request.method];
			const result =
				handler === undefined
					? Effect.fail(
							new McpError({
								code: JSON_RPC_ERROR_CODES.methodNotFound,
								message: `Method not found: ${request.method}`,
								data: undefined,
							}),
						)
					: handler(request);
			return result.pipe(
				Effect.matchEffect({
					onSuccess: (value) => peer.send({ jsonrpc: "2.0", id: request.id, result: value }),
					onFailure: (error) =>
						peer.send({
							jsonrpc: "2.0",
							id: request.id,
							error: { code: error.code, message: error.message, data: error.data },
						}),
				}),
				Effect.ignore,
			);
		};
		yield* peer.messages.pipe(
			Stream.runForEach((message) => {
				if (isJsonRpcRequest(message)) {
					Queue.offerUnsafe(requests, message);
					return Effect.asVoid(Effect.forkChild(answer(message)));
				}
				if (isJsonRpcNotification(message)) return Effect.asVoid(Queue.offer(notifications, message));
				if (isJsonRpcResponse(message)) {
					const deferred = waiting.get(message.id);
					return deferred === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(deferred, message));
				}
				return Effect.void;
			}),
			Effect.forkScoped,
		);
		return {
			notifications,
			requests,
			request: (method, params) =>
				Effect.gen(function* () {
					const id = `server-${nextId++}`;
					const deferred = yield* Deferred.make<JsonRpcResponse>();
					waiting.set(id, deferred);
					yield* peer.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
					return yield* Deferred.await(deferred);
				}),
			notify: (method, params) => peer.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
		};
	});
}
