// A connection to a pi-env daemon as a scoped resource: its requests as Effects and Streams, its log as a Stream.

import {
	type ConnectionOptions,
	Connection as PiConnection,
	type Reply as PiReply,
	type RemoteInfo,
	type RequestOptions,
} from "@earendil-works/pi-env";
import { Context, Effect, PubSub, Queue, Schema, type Scope, Stream, Tracer } from "effect";
import type { RemoteFailed } from "../errors.ts";
import { remote, remoteAbortable } from "./rejection.ts";

/** A request's id in its daemon session, which `kill` names together with the session. */
export const RequestId = Schema.Int.pipe(Schema.brand("RequestId"));

/** A request's id in its daemon session. */
export type RequestId = typeof RequestId.Type;

/**
 * A daemon session: one start of the daemon. Handles a session opened are valid only while it lives; after the
 * connection was lost and started again, the new session has a new id.
 */
export const SessionId = Schema.Int.pipe(Schema.brand("SessionId"));

/** A daemon session. */
export type SessionId = typeof SessionId.Type;

/** The JSON of a request or an answer: an object (Pi's `Json`). */
export const Json = Schema.Record(Schema.String, Schema.Unknown);

/** The JSON of a request or an answer. */
export type Json = typeof Json.Type;

/** The daemon's answer to a request (Pi's `Reply`): its JSON, its binary payload and the session that answered. */
export const Reply = Schema.Struct({ json: Json, payload: Schema.Uint8Array, session: SessionId });

/** The daemon's answer to a request. */
export type Reply = typeof Reply.Type;

/** What a request sends besides its JSON: a binary payload, and the daemon session it must run in. */
export type RequestInput = Pick<RequestOptions, "payload"> & { readonly session?: SessionId };

/** The request was sent: its id and session, for `kill`. */
const RequestStarted = Schema.Struct({ kind: Schema.Literal("started"), id: RequestId, session: SessionId });

/** A progress event of the daemon, such as a chunk of an `exec`'s output. */
const RequestProgress = Schema.Struct({ kind: Schema.Literal("event"), json: Json, payload: Schema.Uint8Array });

/** The reply, the last element of a request's stream. */
const RequestReplied = Schema.Struct({ kind: Schema.Literal("reply"), reply: Reply });

/**
 * One element of `requestEvents`: the request's start, each progress event of the daemon, and last the reply.
 * `RequestEvent.match` picks a handler per `kind` and `RequestEvent.guards` tests for one.
 */
export const RequestEvent = Schema.Union([RequestStarted, RequestProgress, RequestReplied]).pipe(
	Schema.toTaggedUnion("kind"),
);

/** One element of `requestEvents`. */
export type RequestEvent = typeof RequestEvent.Type;

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
	/** The live daemon session; starts it if needed. */
	readonly session: Effect.Effect<SessionId, RemoteFailed>;
	/** Sends one request of the protocol and waits for its reply. Interrupting the fiber cancels the request. */
	readonly request: (op: string, json: Json, input?: RequestInput) => Effect.Effect<Reply, RemoteFailed>;
	/** Sends one request as a Stream of its start, its events and its reply; ending the stream early cancels it. */
	readonly requestEvents: (op: string, json: Json, input?: RequestInput) => Stream.Stream<RequestEvent, RemoteFailed>;
	/** Kills one running `exec` without cancelling its request, which then settles with the killed status. */
	readonly kill: (id: RequestId, session: SessionId) => Effect.Effect<void>;
	/** The daemon's and the transport's diagnostic output, from when the stream is run. */
	readonly logs: Stream.Stream<string>;
}

/**
 * The command that starts the daemon, before its `serve` arguments: fixed, or computed by an Effect at each start
 * (whose failure fails that start with code `spawn_error` and the failure's message, and the next request tries
 * again). The Effect runs with the services of the fiber that made the connection.
 */
export interface Options<E = never, R = never> {
	readonly command: ReadonlyArray<string> | Effect.Effect<ReadonlyArray<string>, E, R>;
}

/** A connection to the daemon `options.command` starts; it starts on its first request and stops with the scope. */
export const make = Effect.fn("Connection.make")(function* <E = never, R = never>(options: Options<E, R>) {
	// Pi keeps the command and runs it at each start, long after this span ended: without it, the command's spans
	// start their own trace. The parent span is an optional reference of the tracer: no service an Effect asks for.
	const captured = yield* Effect.context<R>();
	const context = Context.omit(Tracer.ParentSpan)(captured) as Context.Context<R>;
	const command = options.command;
	// Pi computes the command at each start: the Effect runs then, with the services captured here.
	const start: ConnectionOptions["command"] = Effect.isEffect(command)
		? () => Effect.runPromiseWith(context)(command)
		: command;
	const made = yield* acquire((onLog) =>
		Effect.sync(() => ({ connection: new PiConnection({ command: start, onLog }) })),
	);
	return made.connection;
});

/**
 * What `create` makes with the log callback it is given, with its Pi connection in Effect terms and closed when the
 * scope closes: for pi-env's functions that make connections themselves (SSH), with what they return beside it.
 * Untraced: the function that makes the connection (`Connection.make`, `Ssh.connect`) is the span.
 */
export const acquire = Effect.fnUntraced(function* <A extends { readonly connection: PiConnection }, E>(
	create: (onLog: (text: string) => void) => Effect.Effect<A, E>,
): Effect.fn.Return<Omit<A, "connection"> & { readonly connection: Connection }, E, Scope.Scope> {
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

/** Pi's connection in Effect terms, each request a span named for it. */
function wrap(pi: PiConnection, logs: Stream.Stream<string>): Connection {
	return {
		pi,
		info: remoteAbortable((signal) => pi.info(signal)).pipe(Effect.withSpan("Connection.info")),
		session: remote(() => pi.session()).pipe(Effect.map(SessionId.make), Effect.withSpan("Connection.session")),
		request: Effect.fn("Connection.request")((op: string, json: Json, input?: RequestInput) =>
			Effect.map(
				remoteAbortable((signal) => pi.request(op, json, { ...input, signal })),
				fromPiReply,
			),
		),
		// The callback's buffer is unbounded: Pi's callbacks cannot wait, and an event must not be dropped.
		requestEvents: (op, json, input) =>
			Stream.callback<RequestEvent, RemoteFailed>((queue) =>
				remoteAbortable((signal) =>
					pi.request(op, json, {
						...input,
						signal,
						onStart: (id, session) =>
							Queue.offerUnsafe(queue, {
								kind: "started",
								id: RequestId.make(id),
								session: SessionId.make(session),
							}),
						onEvent: (event, payload) => Queue.offerUnsafe(queue, { kind: "event", json: event, payload }),
					}),
				).pipe(
					Effect.andThen((reply) => Queue.offer(queue, { kind: "reply", reply: fromPiReply(reply) })),
					Effect.andThen(Queue.end(queue)),
				),
			).pipe(Stream.withSpan("Connection.requestEvents")),
		kill: Effect.fn("Connection.kill")((id: RequestId, session: SessionId) =>
			Effect.sync(() => pi.kill(id, session)),
		),
		logs,
	};
}

/** Pi's reply, its session branded where it enters. */
function fromPiReply(reply: PiReply): Reply {
	return { json: reply.json, payload: reply.payload, session: SessionId.make(reply.session) };
}
