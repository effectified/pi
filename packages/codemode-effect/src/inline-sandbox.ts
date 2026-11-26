// Pi's sandbox on the calling thread (`InlineCodemodeSandbox`) in Effect terms: for runtimes without worker threads,
// where an interrupt budget, not a timer, stops a script that computes.

import {
	type CodemodeWasmModule,
	InlineCodemodeSandbox,
	type InlineCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode/portable";
import type { SchemaConversionError } from "@effectified/pi-agent";
import type { Effect, Scope } from "effect";
import { acquire } from "./acquire.ts";
import type { ToolRejected } from "./errors.ts";
import type * as Sandbox from "./sandbox.ts";

/** What `make` takes: every kind's options, the compiled QuickJS module and the interrupt budget. */
export interface Options<R> extends Sandbox.Options<R>, Pick<InlineCodemodeSandboxOptions, "interruptBudget"> {
	/** The compiled QuickJS module: `Wasm.load` on Node and Bun, Wrangler's module on Cloudflare. */
	readonly wasm: CodemodeWasmModule;
}

/**
 * A sandbox whose VMs run on the calling thread: a script that computes blocks it until it awaits a tool or uses up
 * its interrupt budget (then it ends with `kind: "timeout"`). Needs no worker threads, files or Node built-ins.
 * Closed when the scope closes.
 */
export function make<R = never>(
	options: Options<R>,
): Effect.Effect<Sandbox.Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> {
	return acquire(
		options,
		(tools, globals) =>
			new InlineCodemodeSandbox({
				tools,
				globals,
				timeoutMs: options.timeoutMs,
				memoryLimitBytes: options.memoryLimitBytes,
				wasm: options.wasm,
				interruptBudget: options.interruptBudget,
			}),
	);
}
