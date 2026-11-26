// pi-mcp's transports as scoped resources: stdio, Streamable HTTP and a pipe to a program something else runs, each
// closed with its scope, their callbacks given as Effects and Queues.

import {
	type McpPipe,
	type McpPipeHandlers,
	PipeTransport,
	type PipeTransportOptions,
	StdioTransport,
	type StdioTransportOptions,
	StreamableHttpTransport,
	type StreamableHttpTransportOptions,
} from "@earendil-works/pi-mcp";
import { Effect, Queue, type Scope } from "effect";
import { type Auth, toAuthProvider } from "./auth.ts";
import type { McpFailure } from "./errors.ts";
import { currentRunner } from "./run-in-pi.ts";

/** Pi's stdio transport options, with the server's stderr going to a queue instead of a callback. */
export interface StdioOptions extends Omit<StdioTransportOptions, "onStderr"> {
	/** Every chunk of the server's stderr, decoded as UTF-8, when `stderr` is `"pipe"` (the default). */
	readonly stderrChunks?: Queue.Enqueue<string>;
}

/**
 * A server started as a local program that speaks MCP over stdin and stdout, once a client connects over it. Closing
 * the scope (or the client) ends the program as Pi does: stdin closed, then SIGTERM, then SIGKILL.
 */
export function stdioTransport(options: StdioOptions): Effect.Effect<StdioTransport, never, Scope.Scope> {
	const { stderrChunks, ...rest } = options;
	return scoped(() => new StdioTransport({ ...rest, ...stderrTo(stderrChunks) }));
}

/** Pi's Streamable HTTP transport options, with the bearer tokens from an `Auth` instead of Pi's provider. */
export interface StreamableHttpOptions<R = never> extends Omit<StreamableHttpTransportOptions, "authProvider"> {
	/** Where the bearer token of each request comes from: an application's own, or the OAuth subpath's. */
	readonly auth?: Auth<R>;
}

/** A server reached over Streamable HTTP. Closing the scope (or the client) ends its session as Pi does. */
export function streamableHttpTransport<R = never>(
	options: StreamableHttpOptions<R>,
): Effect.Effect<StreamableHttpTransport, never, Scope.Scope | R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const { auth, ...rest } = options;
		return yield* scoped(
			() =>
				new StreamableHttpTransport({
					...rest,
					...(auth === undefined ? {} : { authProvider: toAuthProvider(auth, run) }),
				}),
		);
	});
}

/** A running program's stdio as an application gives it: Pi's `McpPipe`, its end an Effect. */
export interface Pipe extends Omit<McpPipe, "exited"> {
	/** Succeeds when the program has ended, whatever the reason, also after `close()`; fails when it failed. */
	readonly exited: Effect.Effect<unknown, McpFailure>;
}

/** Pi's pipe transport options, with the program started by an Effect and its stderr going to a queue. */
export interface PipeOptions<R = never> extends Omit<PipeTransportOptions, "open" | "onStderr"> {
	/** Starts the program; `handlers` receive its output from then on. */
	readonly open: (handlers: McpPipeHandlers) => Effect.Effect<Pipe, McpFailure, R>;
	/** Every chunk of the program's stderr, decoded as UTF-8. */
	readonly stderrChunks?: Queue.Enqueue<string>;
}

/**
 * MCP's stdio framing over a program that something else runs (another machine, a sandbox), once a client connects
 * over it. Closing the scope closes the program's stdin, then closes the pipe if it has not ended in time.
 */
export function pipeTransport<R = never>(
	options: PipeOptions<R>,
): Effect.Effect<PipeTransport, never, Scope.Scope | R> {
	return Effect.gen(function* () {
		const run = yield* currentRunner<R>();
		const { open, stderrChunks, ...rest } = options;
		return yield* scoped(
			() =>
				new PipeTransport({
					...rest,
					...stderrTo(stderrChunks),
					open: async (handlers) => {
						const pipe = await run(open(handlers));
						return {
							write: (data) => pipe.write(data),
							closeStdin: () => pipe.closeStdin(),
							close: () => pipe.close(),
							exited: run(pipe.exited),
						};
					},
				}),
		);
	});
}

/** Pi's `onStderr` option feeding `queue`, or nothing. */
function stderrTo(queue: Queue.Enqueue<string> | undefined): { onStderr?: (chunk: string) => void } {
	return queue === undefined ? {} : { onStderr: (chunk) => Queue.offerUnsafe(queue, chunk) };
}

/** A transport `make` creates, closed with the scope. Closing an unstarted or already closed transport is a no-op. */
function scoped<T extends { close(): Promise<void> }>(make: () => T): Effect.Effect<T, never, Scope.Scope> {
	return Effect.acquireRelease(Effect.sync(make), (transport) => Effect.promise(() => transport.close()));
}
