// Chord's links as scoped resources: closed when their scope closes, their incoming messages a Stream.

import {
	type IpcPort,
	ipcLink,
	type Link,
	memoryLinkPair,
	type WebSocketLike,
	webSocketLink,
} from "@earendil-works/chord";
import { Effect, Queue, type Scope, Stream } from "effect";
import { dual } from "effect/Function";

// Chord's link types: the link adapters implement, what an IPC port and a WebSocket must have, codecs and limits.
export type { Codec, Compression, IpcPort, Link, Message, PartLimits, WebSocketLike } from "@earendil-works/chord";

/**
 * Chord's `memoryLinkPair`: two ends of one link in memory, both closed when the scope closes. What one sends, the other
 * receives a microtask later, in order: a host `accept`s one end and another `connect`s the other.
 */
export const memoryPair: Effect.Effect<readonly [Link, Link], never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(memoryLinkPair),
	([a, b]) =>
		Effect.sync(() => {
			a.close();
			b.close();
		}),
);

/** Chord's `ipcLink`: a link over a Node IPC channel (a forked child, or `process` in the child), closed with the scope. */
export function ipc(port: IpcPort): Effect.Effect<Link, never, Scope.Scope> {
	return scoped(() => ipcLink(port));
}

/** Chord's `webSocketLink`: a link over a WebSocket (the browser's, or `ws` in Node), closed with the scope. */
export function webSocket(socket: WebSocketLike): Effect.Effect<Link, never, Scope.Scope> {
	return scoped(() => webSocketLink(socket));
}

/** The link `make` gives, closed when the scope closes. */
function scoped(make: () => Link): Effect.Effect<Link, never, Scope.Scope> {
	return Effect.acquireRelease(Effect.sync(make), (link) => Effect.sync(() => link.close()));
}

/**
 * The messages arriving on `link`, in order, those that arrived before included; the Stream ends when either end
 * closes. It sets the link's one message listener: a link a host took (`accept`, `connect`) is the host's, not this.
 */
export function messages(link: Link): Stream.Stream<Uint8Array> {
	return Stream.callback<Uint8Array>((queue) =>
		Effect.sync(() => {
			link.onMessage((message) => {
				Queue.offerUnsafe(queue, message);
			});
			link.onClose(() => {
				Queue.endUnsafe(queue);
			});
		}),
	);
}

/** Sends `message` on `link`; nothing once it is closed. Data-first or data-last (`pipe(link, Link.send(message))`). */
export const send: {
	(message: Uint8Array): (link: Link) => Effect.Effect<void>;
	(link: Link, message: Uint8Array): Effect.Effect<void>;
} = dual(2, (link: Link, message: Uint8Array): Effect.Effect<void> => Effect.sync(() => link.send(message)));

/** Closes both ends of `link`; what is not delivered yet is dropped. */
export function close(link: Link): Effect.Effect<void> {
	return Effect.sync(() => link.close());
}
