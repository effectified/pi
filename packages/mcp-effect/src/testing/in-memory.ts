// pi-mcp's in-memory transport pair as a scoped resource: the client end for `McpClient`, the other end as an Effect
// peer that plays the server in a test.

import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { type Cause, Effect, Queue, type Scope, Stream } from "effect";
import { fromPi, type McpFailure } from "../errors.ts";

/** The server's end of an in-memory pair, in Effect terms. */
export interface Peer {
	/** Every message the client sent, from when the pair was made. It ends when the pair closes. One reader only. */
	readonly messages: Stream.Stream<JsonRpcMessage>;
	/** Delivers `message` to the client. */
	readonly send: (message: JsonRpcMessage) => Effect.Effect<void, McpFailure>;
}

/** Both ends of an in-memory pair: Pi's client transport, and the server's end as a `Peer`. */
export interface InMemoryPair {
	/** Give it to `McpClient.connect`. `emitError` reports a transport error to the client, as a broken one would. */
	readonly client: InMemoryTransport;
	readonly server: Peer;
}

/** Two linked in-memory transports, the server's end started; the scope closes both. */
export function inMemoryTransportPair(): Effect.Effect<InMemoryPair, never, Scope.Scope> {
	return Effect.gen(function* () {
		const pair = yield* Effect.acquireRelease(Effect.sync(createInMemoryTransportPair), (pair) =>
			Effect.promise(() => Promise.all([pair.client.close(), pair.server.close()])),
		);
		const received = yield* Queue.unbounded<JsonRpcMessage, Cause.Done>();
		pair.server.onMessage((message) => Queue.offerUnsafe(received, message));
		pair.server.onClose(() => Queue.endUnsafe(received));
		// Starting an in-memory transport only marks it open; it cannot fail before it is closed.
		yield* Effect.promise(() => pair.server.start());
		return {
			client: pair.client,
			server: {
				messages: Stream.fromQueue(received),
				send: (message) => Effect.tryPromise({ try: () => pair.server.send(message), catch: fromPi }),
			},
		};
	});
}
