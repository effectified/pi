// pi-mcp's client in Effect terms: a connection as a scoped resource and a service, its calls as Effects, and what
// the server sends unasked (notifications, reported errors) as Streams.

import {
	type InitializeResult,
	type McpClientOptions,
	type McpTransport,
	McpClient as PiMcpClient,
	type Root,
} from "@earendil-works/pi-mcp";
import { Context, Deferred, type Duration, Effect, Exit, Layer, Queue, type Scope, Stream } from "effect";
import { fromPi, type McpError, type McpFailure } from "./errors.ts";
import { type PiRequestOptions, type RequestOptions, request } from "./request.ts";
import { currentRunner } from "./run-in-pi.ts";

/** pi-mcp's client options in Effect terms: the timeout is a `Duration` on `Clock`, the roots an Effect. */
export interface ClientOptions<R = never> extends Omit<McpClientOptions, "requestTimeoutMs" | "roots"> {
	/** The `timeout` of every request that names none. Default: 30 seconds, as in Pi. */
	readonly requestTimeout?: Duration.Input;
	/** Answers the server's `roots/list`; given, the client declares the `roots` capability. */
	readonly roots?: Effect.Effect<ReadonlyArray<Root>, McpFailure, R>;
}

/** What a call of Pi's client resolves with. */
type Resolved<K extends keyof PiMcpClient> = PiMcpClient[K] extends (...args: never[]) => Promise<infer A> ? A : never;

/** A connected MCP client: the server's answer to `initialize`, and Pi's calls as Effects. */
export interface McpClientService {
	/** The server's answer to `initialize`: protocol version, capabilities, server info and instructions. */
	readonly initialize: InitializeResult;
	/** Sends `method` and succeeds with the server's result as it arrived. */
	readonly request: (
		method: string,
		params?: Record<string, unknown>,
		options?: RequestOptions,
	) => Effect.Effect<unknown, McpFailure>;
	/** Sends the notification `method`. */
	readonly notify: (method: string, params?: Record<string, unknown>) => Effect.Effect<void, McpFailure>;
	/** Pings the server. */
	readonly ping: (options?: RequestOptions) => Effect.Effect<void, McpFailure>;
	/** Every tool of the server, following its pages. */
	readonly listTools: (options?: RequestOptions) => Effect.Effect<Resolved<"listTools">, McpFailure>;
	/** Every resource of the server, following its pages. */
	readonly listResources: (options?: RequestOptions) => Effect.Effect<Resolved<"listResources">, McpFailure>;
	/** One page of resources, starting at `cursor`. */
	readonly listResourcesPage: (
		cursor?: string,
		options?: RequestOptions,
	) => Effect.Effect<Resolved<"listResourcesPage">, McpFailure>;
	/** Every resource template of the server, following its pages. */
	readonly listResourceTemplates: (
		options?: RequestOptions,
	) => Effect.Effect<Resolved<"listResourceTemplates">, McpFailure>;
	/** One page of resource templates, starting at `cursor`. */
	readonly listResourceTemplatesPage: (
		cursor?: string,
		options?: RequestOptions,
	) => Effect.Effect<Resolved<"listResourceTemplatesPage">, McpFailure>;
	/** Reads the resource at `uri`. */
	readonly readResource: (
		uri: string,
		options?: RequestOptions,
	) => Effect.Effect<Resolved<"readResource">, McpFailure>;
	/** Calls the tool `name`. A tool that failed is a result with `isError`, not a failure of the Effect. */
	readonly callTool: (
		name: string,
		args?: Record<string, unknown>,
		options?: RequestOptions,
	) => Effect.Effect<Resolved<"callTool">, McpFailure>;
	/**
	 * The `params` of each notification `method` the server sends from when the Stream starts. It ends when the
	 * connection closes.
	 */
	readonly notifications: (method: string) => Stream.Stream<unknown>;
	/**
	 * What the client reports without failing a call (a transport error, an answer to an unknown request), from when
	 * the Stream starts. It ends when the connection closes.
	 */
	readonly errors: Stream.Stream<McpFailure>;
	/** Succeeds once the connection has closed: the transport dropped, or the client's scope closed. */
	readonly closed: Effect.Effect<void>;
	/**
	 * Answers the server's requests `method` (`sampling/createMessage`, `elicitation/create`, ...) with `handler` until
	 * the scope closes. A server's cancellation interrupts the handler; its `McpError` is the error response.
	 */
	readonly handle: <R>(
		method: string,
		handler: (params: unknown) => Effect.Effect<unknown, McpError, R>,
	) => Effect.Effect<void, never, Scope.Scope | R>;
}

/** The connected MCP client of this program. */
export class McpClient extends Context.Service<McpClient, McpClientService>()("@effectified/pi-mcp/McpClient") {
	/**
	 * Connects a client over `transport` and initializes the session. The scope closes the client and its transport;
	 * interrupting or timing out the connection closes them at once.
	 */
	static connect<R = never>(
		transport: McpTransport,
		options: ClientOptions<R>,
	): Effect.Effect<McpClientService, McpFailure, Scope.Scope | R> {
		return connect(transport, options);
	}

	/** A client connected over `transport` for as long as the Layer lives. */
	static layer<E, R, RRoots = never>(
		transport: Effect.Effect<McpTransport, E, R>,
		options: ClientOptions<RRoots>,
	): Layer.Layer<McpClient, E | McpFailure, Exclude<R | RRoots, Scope.Scope>> {
		return Layer.effect(
			McpClient,
			Effect.flatMap(transport, (connection) => connect(connection, options)),
		);
	}
}

// Pi's own default (`DEFAULT_REQUEST_TIMEOUT_MS` in its client), which it does not export.
const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "30 seconds";

/** `McpClient.connect`: Pi's client created, connected and closed with the scope. */
function connect<R = never>(
	transport: McpTransport,
	options: ClientOptions<R>,
): Effect.Effect<McpClientService, McpFailure, Scope.Scope | R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const { requestTimeout = DEFAULT_REQUEST_TIMEOUT, roots, ...rest } = options;
		const client = yield* Effect.acquireRelease(
			Effect.sync(
				() =>
					new PiMcpClient({
						...rest,
						// Pi's timer is off: `request` keeps every deadline on `Clock`.
						requestTimeoutMs: 0,
						...(roots === undefined ? {} : { roots: () => run(roots) }),
					}),
			),
			(client) => Effect.promise(() => client.close()),
		);
		const closed = yield* Deferred.make<void>();
		client.onClose(() => Deferred.doneUnsafe(closed, Effect.void));
		const initialize = yield* request(() => client.connect(transport), requestTimeout, undefined).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.promise(() => client.close()) : Effect.void)),
		);
		const call = <A>(start: (options: PiRequestOptions) => Promise<A>, options: RequestOptions | undefined) =>
			request(start, options?.timeout ?? requestTimeout, options?.progress);
		return {
			initialize,
			request: (method, params, options) => call((pi) => client.request(method, params, pi), options),
			notify: (method, params) => Effect.tryPromise({ try: () => client.notify(method, params), catch: fromPi }),
			ping: (options) => call((pi) => client.ping(pi), options),
			listTools: (options) => call((pi) => client.listTools(pi), options),
			listResources: (options) => call((pi) => client.listResources(pi), options),
			listResourcesPage: (cursor, options) => call((pi) => client.listResourcesPage(cursor, pi), options),
			listResourceTemplates: (options) => call((pi) => client.listResourceTemplates(pi), options),
			listResourceTemplatesPage: (cursor, options) =>
				call((pi) => client.listResourceTemplatesPage(cursor, pi), options),
			readResource: (uri, options) => call((pi) => client.readResource(uri, pi), options),
			callTool: (name, args, options) => call((pi) => client.callTool(name, args, pi), options),
			notifications: (method) => untilClosed(client, (emit) => client.onNotification(method, emit)),
			errors: untilClosed(client, (emit) => client.onError((error) => emit(fromPi(error)))),
			closed: Deferred.await(closed),
			handle: <RHandler>(
				method: string,
				handler: (params: unknown) => Effect.Effect<unknown, McpError, RHandler>,
			): Effect.Effect<void, never, Scope.Scope | RHandler> =>
				Effect.gen(function* () {
					const answer = yield* currentRunner<RHandler>();
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							client.setRequestHandler(method, (params, { signal }) => answer(handler(params), signal)),
						),
						(remove) => Effect.sync(remove),
					);
				}),
		} satisfies McpClientService;
	});
}

/** The values a Pi listener receives from when the Stream starts until the client closes. */
function untilClosed<A>(client: PiMcpClient, listen: (emit: (value: A) => void) => () => void): Stream.Stream<A> {
	return Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const stopListening = listen((value) => Queue.offerUnsafe(queue, value));
				const stopWaiting = client.onClose(() => Queue.endUnsafe(queue));
				if (client.connectionState === "closed") Queue.endUnsafe(queue);
				return () => {
					stopListening();
					stopWaiting();
				};
			}),
			(stop) => Effect.sync(stop),
		),
	);
}
