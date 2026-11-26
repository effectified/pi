// A connection to a pi-env daemon as a scoped resource: its requests as Effects and Streams, its log as a Stream.

import {
	type ConnectionOptions,
	Connection as PiConnection,
	type RemoteInfo,
	type Reply,
	type RequestOptions,
} from "@earendil-works/pi-env";
import { Effect, PubSub, Queue, type Scope, Stream } from "effect";
import type { RemoteFailed } from "../errors.ts";
import { remote, remoteAbortable } from "./rejection.ts";

/** The JSON of a request or an answer: an object. */
export type Json = Reply["json"];

/** What a request sends besides its JSON: a binary payload, and the daemon session it must run in. */
export type RequestInput = Pick<RequestOptions, "payload" | "session">;

/**
 * One element of `requestEvents`: the request's id and session once it is sent (for `kill`), each progress event
 * of the daemon (an `exec`'s output), and last the reply.
 */
export type RequestEvent =
	| { readonly kind: "started"; readonly id: number; readonly session: number }
	| { readonly kind: "event"; readonly json: Json; readonly payload: Uint8Array }
	| { readonly kind: "reply"; readonly reply: Reply };

/**
 * A connection to one pi-env daemon. It starts the daemon on its first request and again after it was lost; a
 * request in flight when it is lost fails with `RemoteFailed` (`lost`), and a mutation's outcome is then unknown.
 * Closing its scope stops the daemon, which kills everything it started.
 */
export interface Connection {
	/** Pi's connection, for Pi's own functions that take one. */
	readonly pi: PiConnection;
	/** What the daemon reports about its machine; starts it if needed. Interrupting stops waiting, not the start. */
	readonly info: Effect.Effect<RemoteInfo, RemoteFailed>;
	/** The live daemon session's id; starts it if needed. */
	readonly session: Effect.Effect<number, RemoteFailed>;
	/** Sends one request of the protocol and waits for its reply. Interrupting the fiber cancels the request. */
	readonly request: (op: string, json: Json, input?: RequestInput) => Effect.Effect<Reply, RemoteFailed>;
	/** Sends one request as a Stream of its start, its events and its reply; ending the stream early cancels it. */
	readonly requestEvents: (op: string, json: Json, input?: RequestInput) => Stream.Stream<RequestEvent, RemoteFailed>;
	/** Kills one running `exec` without cancelling its request, which then settles with the killed status. */
	readonly kill: (id: number, session: number) => Effect.Effect<void>;
	/** The daemon's and the transport's diagnostic output, from when the stream is run. */
	readonly logs: Stream.Stream<string>;
}

/**
 * The command that starts the daemon, before its `serve` arguments: fixed, or computed by an Effect at each start
 * (whose failure fails that start with code `spawn_error`, and the next request tries again).
 */
export interface Options {
	readonly command: ReadonlyArray<string> | Effect.Effect<ReadonlyArray<string>, unknown>;
}

/** A connection to the daemon `options.command` starts; it starts on its first request and stops with the scope. */
export function make(options: Options): Effect.Effect<Connection, never, Scope.Scope> {
	const command = options.command;
	// The Effect needs no service, so Pi's start runs it on its own.
	const start: ConnectionOptions["command"] = Effect.isEffect(command) ? () => Effect.runPromise(command) : command;
	return Effect.map(
		acquire((onLog) => Effect.sync(() => ({ connection: new PiConnection({ command: start, onLog }) }))),
		({ connection }) => connection,
	);
}

/**
 * What `create` makes with the log callback it is given, with its Pi connection in Effect terms and closed when the
 * scope closes: for pi-env's functions that make connections themselves (SSH), with what they return beside it.
 */
export function acquire<A extends { readonly connection: PiConnection }, E>(
	create: (onLog: (text: string) => void) => Effect.Effect<A, E>,
): Effect.Effect<Omit<A, "connection"> & { readonly connection: Connection }, E, Scope.Scope> {
	return Effect.gen(function* () {
		// Without a subscriber a line is dropped, as Pi drops it without `onLog`.
		const logs = yield* PubSub.unbounded<string>();
		const made = yield* Effect.acquireRelease(
			create((text) => PubSub.publishUnsafe(logs, text)),
			({ connection }) => Effect.sync(() => connection.close()).pipe(Effect.andThen(PubSub.shutdown(logs))),
			// `Ssh.connect` detects and deploys before it has a connection: interrupting stops waiting for that. A Pi
			// connection it still makes is lazy, so leaving it unclosed starts nothing.
			{ interruptible: true },
		);
		return { ...made, connection: wrap(made.connection, Stream.fromPubSub(logs)) };
	});
}

/** Pi's connection in Effect terms. */
function wrap(pi: PiConnection, logs: Stream.Stream<string>): Connection {
	return {
		pi,
		info: remoteAbortable((signal) => pi.info(signal)),
		session: remote(() => pi.session()),
		request: (op, json, input) => remoteAbortable((signal) => pi.request(op, json, { ...input, signal })),
		requestEvents: (op, json, input) =>
			Stream.callback<RequestEvent, RemoteFailed>((queue) =>
				remoteAbortable((signal) =>
					pi.request(op, json, {
						...input,
						signal,
						onStart: (id, session) => Queue.offerUnsafe(queue, { kind: "started", id, session }),
						onEvent: (event, payload) => Queue.offerUnsafe(queue, { kind: "event", json: event, payload }),
					}),
				).pipe(
					Effect.andThen((reply) => Queue.offer(queue, { kind: "reply", reply })),
					Effect.andThen(Queue.end(queue)),
				),
			),
		kill: (id, session) => Effect.sync(() => pi.kill(id, session)),
		logs,
	};
}
