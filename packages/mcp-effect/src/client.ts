// pi-mcp's client in Effect terms: a connection as a scoped resource and a service, its calls as Effects, and what
// the server sends unasked (notifications, reported errors) as Streams.

import {
	type InitializeResult,
	type McpClientOptions,
	type McpTransport,
	McpClient as PiMcpClient,
	type Tool as PiTool,
	type Root,
} from "@earendil-works/pi-mcp";
import { Array as Arr, Context, Deferred, type Duration, Effect, Layer, Queue, type Scope, Stream } from "effect";
import { fromPi, type McpError, type McpFailure } from "./errors.ts";
import { McpToolName } from "./names.ts";
import { type PiRequestOptions, type RequestOptions, request } from "./request.ts";
import { currentRunner } from "./run-in-pi.ts";

/** pi-mcp's client options in Effect terms: the timeout is a `Duration` on `Clock`, the roots an Effect. */
export interface ClientOptions<R = never> extends Omit<McpClientOptions, "requestTimeoutMs" | "roots"> {
	/** The `timeout` of every request that names none. Default: 30 seconds, as in Pi. */
	readonly requestTimeout?: Duration.Input;
	/** Answers the server's `roots/list`; given, the client declares the `roots` capability. */
	readonly roots?: Effect.Effect<ReadonlyArray<Root>, McpFailure, R>;
}

/** A tool of the server as Pi lists it, its name branded: what `callTool` takes. */
export type Tool = Omit<PiTool, "name"> & { readonly name: McpToolName };

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
	readonly listTools: (options?: RequestOptions) => Effect.Effect<ReadonlyArray<Tool>, McpFailure>;
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
		name: McpToolName,
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
export class McpClient extends Context.Service<McpClient, McpClientService>()("@effectified/pi-mcp/client/McpClient") {
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
const connect: <R = never>(
	transport: McpTransport,
	options: ClientOptions<R>,
) => Effect.Effect<McpClientService, McpFailure, Scope.Scope | R> = Effect.fn("McpClient.connect")(function* <R>(
	transport: McpTransport,
	options: ClientOptions<R>,
) {
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
		Effect.onError(() => Effect.promise(() => client.close())),
	);
	return service(client, initialize, requestTimeout, Deferred.await(closed));
});

/** The calls of the connected `client` as the service's Effects, each with a span of its own. */
function service(
	client: PiMcpClient,
	initialize: InitializeResult,
	requestTimeout: Duration.Input,
	closed: Effect.Effect<void>,
): McpClientService {
	const call = <A>(start: (options: PiRequestOptions) => Promise<A>, options: RequestOptions | undefined) =>
		request(start, options?.timeout ?? requestTimeout, options?.progress);
	return {
		initialize,
		request: Effect.fn("McpClient.request")(function* (
			method: string,
			params?: Record<string, unknown>,
			options?: RequestOptions,
		) {
			yield* Effect.annotateCurrentSpan("mcp.method", method);
			return yield* call((pi) => client.request(method, params, pi), options);
		}),
		notify: Effect.fn("McpClient.notify")(function* (method: string, params?: Record<string, unknown>) {
			yield* Effect.annotateCurrentSpan("mcp.method", method);
			yield* Effect.tryPromise({ try: () => client.notify(method, params), catch: fromPi });
		}),
		ping: Effect.fn("McpClient.ping")((options?: RequestOptions) => call((pi) => client.ping(pi), options)),
		listTools: Effect.fn("McpClient.listTools")((options?: RequestOptions) =>
			Effect.map(
				call((pi) => client.listTools(pi), options),
				// The names enter here, from the server: the brand marks them as the server's names of its tools.
				Arr.map((tool): Tool => ({ ...tool, name: McpToolName.make(tool.name) })),
			),
		),
		listResources: Effect.fn("McpClient.listResources")((options?: RequestOptions) =>
			call((pi) => client.listResources(pi), options),
		),
		listResourcesPage: Effect.fn("McpClient.listResourcesPage")((cursor?: string, options?: RequestOptions) =>
			call((pi) => client.listResourcesPage(cursor, pi), options),
		),
		listResourceTemplates: Effect.fn("McpClient.listResourceTemplates")((options?: RequestOptions) =>
			call((pi) => client.listResourceTemplates(pi), options),
		),
		listResourceTemplatesPage: Effect.fn("McpClient.listResourceTemplatesPage")(
			(cursor?: string, options?: RequestOptions) =>
				call((pi) => client.listResourceTemplatesPage(cursor, pi), options),
		),
		readResource: Effect.fn("McpClient.readResource")(function* (uri: string, options?: RequestOptions) {
			yield* Effect.annotateCurrentSpan("mcp.resource", uri);
			return yield* call((pi) => client.readResource(uri, pi), options);
		}),
		callTool: Effect.fn("McpClient.callTool")(function* (
			name: McpToolName,
			args?: Record<string, unknown>,
			options?: RequestOptions,
		) {
			yield* Effect.annotateCurrentSpan("mcp.tool", name);
			return yield* call((pi) => client.callTool(name, args, pi), options);
		}),
		notifications: (method) => untilClosed(client, (emit) => client.onNotification(method, emit)),
		errors: untilClosed(client, (emit) => client.onError((error) => emit(fromPi(error)))),
		closed,
		handle: Effect.fn("McpClient.handle")(function* <R>(
			method: string,
			handler: (params: unknown) => Effect.Effect<unknown, McpError, R>,
		) {
			yield* Effect.annotateCurrentSpan("mcp.method", method);
			const answer = yield* currentRunner<R>();
			yield* Effect.acquireRelease(
				Effect.sync(() =>
					client.setRequestHandler(method, (params, { signal }) => answer(handler(params), signal)),
				),
				(remove) => Effect.sync(remove),
			);
		}),
	};
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
