// Pi's remote sandbox (`RemoteCodemodeSandbox`) and its other end (`serveCodemodeRemote`) in Effect terms: the VM runs
// in another isolate, such as a Cloudflare Durable Object, while the tools run here.

import {
	type CodemodeRemote,
	type CodemodeRemoteExchange,
	type CodemodeRemoteRequest,
	type CodemodeServeOptions,
	type CodemodeWasmModule,
	RemoteCodemodeSandbox,
	type RemoteCodemodeSandboxOptions,
	serveCodemodeRemote,
} from "@earendil-works/pi-codemode/portable";
import type { SchemaConversionError } from "@effectified/pi-agent";
import { Effect, type Scope } from "effect";
import { acquire } from "./acquire.ts";
import type { ToolRejected } from "./errors.ts";
import type * as Sandbox from "./sandbox.ts";

/** What `make` takes: every kind's options, the remote, and the interrupt budget asked of it. */
export interface Options<R> extends Sandbox.Options<R>, Pick<RemoteCodemodeSandboxOptions, "interruptBudget"> {
	/**
	 * The remote that runs one execution, evaluated once per execution, such as
	 * `Effect.sync(() => env.CODEMODE_SANDBOX.getByName(sessionId))`. Pi asks for it synchronously, so it must not
	 * suspend.
	 */
	readonly remote: Effect.Effect<CodemodeRemote, never, R>;
}

/** What `serve` takes: Pi's limits for the requests it serves, and the compiled QuickJS module. */
export interface ServeOptions extends Omit<CodemodeServeOptions, "wasm"> {
	readonly wasm: CodemodeWasmModule;
}

/**
 * A sandbox whose VMs run on a remote while its tools run here. A script that computes without calling a tool is
 * limited by the remote's interrupt budget, not by `timeoutMs`; after a deadline, an abort or the scope's close the
 * remote VM stops at its next tool call. Closed when the scope closes. Untraced, as the sandbox keeps this Effect's
 * context for its tools and its remote.
 */
export const make: <R = never>(
	options: Options<R>,
) => Effect.Effect<Sandbox.Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> = Effect.fnUntraced(
	function* <R>(
		options: Options<R>,
	): Effect.fn.Return<Sandbox.Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> {
		const services = yield* Effect.context<R>();
		// Pi asks for the remote synchronously, once per execution.
		const remote = Effect.runSyncWith(services);
		return yield* acquire(
			options,
			(tools, globals) =>
				new RemoteCodemodeSandbox({
					tools,
					globals,
					timeoutMs: options.timeoutMs,
					memoryLimitBytes: options.memoryLimitBytes,
					interruptBudget: options.interruptBudget,
					remote: () => remote(options.remote),
				}),
		);
	},
);

/**
 * The remote end: runs one execution's VM on this thread, sending what it reports through `exchange`, until the VM
 * stopped and its outcome was delivered, or the client asked it to stop. Never fails. Pi takes no abort signal here:
 * interrupting the fiber stops waiting, and the VM runs on until the client stops it or its budget runs out.
 */
export const serve = Effect.fn("RemoteSandbox.serve")(function* (
	request: CodemodeRemoteRequest,
	exchange: CodemodeRemoteExchange,
	options: ServeOptions,
): Effect.fn.Return<void> {
	return yield* Effect.promise(() => serveCodemodeRemote(request, exchange, options));
});
