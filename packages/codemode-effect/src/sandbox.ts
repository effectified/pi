// A codemode sandbox in Effect terms, whichever kind runs its VM: a scoped handle whose executions are Effects and
// whose deterministic runs are scoped, with tools that are Effects.

import type {
	CodemodeExecuteOptions,
	CodemodeResult,
	CodemodeSandboxBase,
	CodemodeSandboxBaseOptions,
	CodemodeTool,
} from "@earendil-works/pi-codemode/portable";
import type { SchemaConversionError, Tool } from "@effectified/pi-agent";
import { Context, type Effect, Layer, type Scope } from "effect";
import type { RunRejected, SandboxClosed, ToolRejected } from "./errors.ts";
import type * as Run from "./run.ts";
import type * as ScriptTool from "./script-tool.ts";

/**
 * A sandbox: each execution gets a fresh QuickJS VM whose only capability is calling the sandbox's tools and
 * globals. It lives in a scope; closing it aborts what still runs and refuses new executions.
 */
export interface Sandbox {
	/** Pi's sandbox, for what takes one as it is, such as Pi Durable's codemode tool. */
	readonly pi: CodemodeSandboxBase;
	/** The tools as Pi holds them now, for `renderDeclarations`. */
	readonly tools: Effect.Effect<ReadonlyArray<CodemodeTool>>;
	/** The globals, fixed when the sandbox was made. */
	readonly globals: ReadonlyArray<CodemodeTool>;
	/** Adds a tool for later executions. Fails with `ToolRejected` when one of that name is registered. */
	readonly register: <R>(tool: Tool.Any<R>) => Effect.Effect<void, ToolRejected | SchemaConversionError, R>;
	/** Removes a tool for later executions; whether there was one. */
	readonly unregister: (name: string) => Effect.Effect<boolean>;
	/**
	 * Runs `code`, the body of an async function, to its result. A script that fails is a result with `ok: false`,
	 * not a failure. Interrupting the fiber aborts the execution (Pi's tool calls are aborted and the VM is asked to
	 * stop) and waits until Pi settled it.
	 */
	readonly execute: (code: string, options?: ExecuteOptions) => Effect.Effect<CodemodeResult, SandboxClosed>;
	/**
	 * Starts `code` as a deterministic run whose calls the caller answers (Pi's `start`). The sandbox's own tools and
	 * globals are not used. Closing the scope aborts the run and waits for its result.
	 */
	readonly start: (
		code: string,
		options: Run.Options,
	) => Effect.Effect<Run.Run, SandboxClosed | RunRejected, Scope.Scope>;
}

/** What one execution takes besides its code: Pi's options, without the abort signal, which the fiber owns. */
export type ExecuteOptions = Omit<CodemodeExecuteOptions, "signal">;

/** What every kind of sandbox takes: Pi's options, with tools and globals that are Effects. */
export interface Options<R> extends Omit<CodemodeSandboxBaseOptions, "tools" | "globals"> {
	/** The script calls them as `tools.<name>(args)`. */
	readonly tools?: ReadonlyArray<Tool.Any<R>>;
	/** The script calls them as top-level functions. */
	readonly globals?: ReadonlyArray<ScriptTool.Global<R>>;
}

/** The sandbox a program runs its scripts in. */
export class Current extends Context.Service<Current, Sandbox>()("@effectified/pi-codemode/Sandbox/Current") {}

/** `Current` from a scoped Effect that makes a sandbox, such as `WorkerSandbox.make`; released with the Layer. */
export function layer<E, R>(acquire: Effect.Effect<Sandbox, E, R>): Layer.Layer<Current, E, Exclude<R, Scope.Scope>> {
	return Layer.effect(Current, acquire);
}
