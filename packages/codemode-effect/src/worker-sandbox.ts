// Pi's sandbox for Node and Bun (`CodemodeSandbox`) in Effect terms: each execution's VM runs in its own worker thread,
// and the admission and lifetime callbacks of those workers are Effects.

import { CodemodeSandbox, type CodemodeSandboxOptions, type CodemodeWasmModule } from "@earendil-works/pi-codemode";
import type { SchemaConversionError } from "@effectified/pi-agent";
import { Cause, type Context, Effect, Exit, type Scope } from "effect";
import { acquire } from "./acquire.ts";
import type { ToolRejected } from "./errors.ts";
import type * as Sandbox from "./sandbox.ts";

/** What `make` takes: every kind's options, and those of worker threads. */
export interface Options<R> extends Sandbox.Options<R>, Pick<CodemodeSandboxOptions, "workerUrl"> {
	/** The compiled QuickJS module, from `Wasm.load`. Default: Pi loads the file of the installed `quickjs-wasi`. */
	readonly wasm?: CodemodeWasmModule;
	/**
	 * Reserves a worker right before each worker starts, and succeeds with its release, which runs once when that
	 * worker exits (not when the result settles). Fails to deny admission: the execution then ends with a `sandbox`
	 * error carrying the failure's message, and no worker starts. Pi calls it synchronously, so it must not suspend;
	 * one that does denies admission too.
	 */
	readonly acquireWorker?: Effect.Effect<Effect.Effect<void>, unknown, R>;
	/**
	 * Runs once for each worker started, with an Effect that waits until that worker exits, which may be after the
	 * result and the scope's close: keep a worker counted against a limit until then. Pi calls it synchronously.
	 */
	readonly onWorkerStarted?: (exited: Effect.Effect<void>) => Effect.Effect<void, never, R>;
}

/**
 * A sandbox whose executions each run in a worker thread with a fresh QuickJS VM, so a script that computes never
 * blocks this thread. Closed when the scope closes. Needs `node:worker_threads` (Node or Bun).
 */
export function make<R = never>(
	options: Options<R> = {},
): Effect.Effect<Sandbox.Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> {
	return Effect.flatMap(Effect.context<R>(), (context) =>
		acquire(
			options,
			(tools, globals) =>
				new CodemodeSandbox({
					tools,
					globals,
					timeoutMs: options.timeoutMs,
					memoryLimitBytes: options.memoryLimitBytes,
					wasm: options.wasm,
					workerUrl: options.workerUrl,
					...workerCallbacks(options, context),
				}),
		),
	);
}

/** Pi's synchronous worker callbacks, each running its Effect with `context`. */
function workerCallbacks<R>(
	options: Options<R>,
	context: Context.Context<R>,
): Pick<CodemodeSandboxOptions, "acquireWorker" | "onWorkerStarted"> {
	const { acquireWorker, onWorkerStarted } = options;
	return {
		...(acquireWorker === undefined
			? {}
			: {
					acquireWorker: () => {
						const release = runSync(acquireWorker, context);
						return () => runSync(release, context);
					},
				}),
		...(onWorkerStarted === undefined
			? {}
			: { onWorkerStarted: (exited) => runSync(onWorkerStarted(Effect.promise(() => exited)), context) }),
	};
}

/**
 * Runs `effect` on this thread, as Pi's synchronous callbacks need. Pi reads a thrown error as the callback's
 * failure, so a failure (or a suspension, which cannot finish here) is thrown as itself.
 */
function runSync<A, E, R>(effect: Effect.Effect<A, E, R>, context: Context.Context<R>): A {
	const exit = Effect.runSyncExitWith(context)(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	throw Cause.squash(exit.cause);
}
