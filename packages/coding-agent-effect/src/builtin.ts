// pi-coding-agent's built-in tools in Effect: read, write, edit, bash, PowerShell, grep, find and ls from Pi's own
// definition factories, each usable as a session's or an extension's tool and run as an Effect; and Pi's per-file
// queue of mutations around an Effect.

import {
	type AgentToolResult,
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createPowerShellTool,
	createPowerShellToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	type ExtensionToolContext,
	withFileMutationQueue as piWithFileMutationQueue,
	type ToolDefinition,
	type ToolsOptions,
} from "@earendil-works/pi-coding-agent";
import type { Env } from "@effectified/pi-env";
import { Effect, Predicate, Stream } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** Pi's execute of a tool definition, whatever its parameters and details. */
type Execute = (
	toolCallId: string,
	params: never,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: ExtensionToolContext,
) => Promise<AgentToolResult<unknown>>;

/** A built-in tool of Pi, made by one of this module's functions for a working directory. */
export interface Builtin<D extends { readonly name: string; readonly execute: Execute }, T> {
	readonly name: D["name"];
	/** Pi's definition, as its factory made it. */
	readonly pi: D;
	/** Pi's definition: what a session's `customTools` and an extension's `tools` take. */
	readonly definition: Effect.Effect<ToolDefinition>;
	/** Pi's agent tool of the same definition (its `create*Tool` factory), for a plain pi-agent-core agent. */
	readonly agentTool: Effect.Effect<T>;
	/**
	 * Runs the tool once with `params`, outside any session: no extension sees the call. Interrupting the fiber aborts
	 * it (a command is killed). A failed call fails with Pi's error, as Pi turns it into an error result.
	 */
	readonly run: (
		params: Parameters<D["execute"]>[1],
		toolCallId?: string,
	) => Effect.Effect<Awaited<ReturnType<D["execute"]>>, CodingAgentFailure>;
}

// Each function's type is written out through Pi's exported factories: inferred, its declaration would name Pi's
// internal tool types (`TypeBoxAgentTool`, a renderer's state), which no `.d.ts` can import.

/** Pi's `read`: a file's text (or image) in pages of lines. */
export function read(
	cwd: string,
	options?: ToolsOptions["read"],
): Builtin<ReturnType<typeof createReadToolDefinition>, ReturnType<typeof createReadTool>> {
	return builtin(createReadToolDefinition(cwd, options), () => createReadTool(cwd, options));
}

/** Pi's `write`: creates or replaces a file. */
export function write(
	cwd: string,
	options?: ToolsOptions["write"],
): Builtin<ReturnType<typeof createWriteToolDefinition>, ReturnType<typeof createWriteTool>> {
	return builtin(createWriteToolDefinition(cwd, options), () => createWriteTool(cwd, options));
}

/** Pi's `edit`: exact text replacements in a file. */
export function edit(
	cwd: string,
	options?: ToolsOptions["edit"],
): Builtin<ReturnType<typeof createEditToolDefinition>, ReturnType<typeof createEditTool>> {
	return builtin(createEditToolDefinition(cwd, options), () => createEditTool(cwd, options));
}

/** Pi's `bash`: a shell command in `cwd`, its output truncated as Pi does. */
export function bash(
	cwd: string,
	options?: ToolsOptions["bash"],
): Builtin<ReturnType<typeof createBashToolDefinition>, ReturnType<typeof createBashTool>> {
	return builtin(createBashToolDefinition(cwd, options), () => createBashTool(cwd, options));
}

/** Pi's `powershell`: a PowerShell command in `cwd`. */
export function powershell(
	cwd: string,
	options?: ToolsOptions["powershell"],
): Builtin<ReturnType<typeof createPowerShellToolDefinition>, ReturnType<typeof createPowerShellTool>> {
	return builtin(createPowerShellToolDefinition(cwd, options), () => createPowerShellTool(cwd, options));
}

/** Pi's `grep`: ripgrep over the files of `cwd`. */
export function grep(
	cwd: string,
	options?: ToolsOptions["grep"],
): Builtin<ReturnType<typeof createGrepToolDefinition>, ReturnType<typeof createGrepTool>> {
	return builtin(createGrepToolDefinition(cwd, options), () => createGrepTool(cwd, options));
}

/** Pi's `find`: files of `cwd` by glob. */
export function find(
	cwd: string,
	options?: ToolsOptions["find"],
): Builtin<ReturnType<typeof createFindToolDefinition>, ReturnType<typeof createFindTool>> {
	return builtin(createFindToolDefinition(cwd, options), () => createFindTool(cwd, options));
}

/** Pi's `ls`: the entries of a directory. */
export function ls(
	cwd: string,
	options?: ToolsOptions["ls"],
): Builtin<ReturnType<typeof createLsToolDefinition>, ReturnType<typeof createLsTool>> {
	return builtin(createLsToolDefinition(cwd, options), () => createLsTool(cwd, options));
}

/** Pi's coding tools, as `createCodingTools` chooses them: read, bash, edit and write. */
export function coding(
	cwd: string,
	options?: ToolsOptions,
): [ReturnType<typeof read>, ReturnType<typeof bash>, ReturnType<typeof edit>, ReturnType<typeof write>] {
	return [read(cwd, options?.read), bash(cwd, options?.bash), edit(cwd, options?.edit), write(cwd, options?.write)];
}

/** Pi's read-only tools, as `createReadOnlyTools` chooses them: read, grep, find and ls. */
export function readOnly(
	cwd: string,
	options?: ToolsOptions,
): [ReturnType<typeof read>, ReturnType<typeof grep>, ReturnType<typeof find>, ReturnType<typeof ls>] {
	return [read(cwd, options?.read), grep(cwd, options?.grep), find(cwd, options?.find), ls(cwd, options?.ls)];
}

/**
 * Runs `effect` in Pi's queue of mutations of the file at `path`: after the mutations of the same file queued before
 * it (by Pi's own tools too), and before those queued after it. It fails as `effect` does; interrupting it interrupts
 * `effect` and frees the queue.
 */
export function withFileMutationQueue<A, E, R>(path: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.flatMap(Effect.context<R>(), (context) => {
		const runExit = Effect.runPromiseExitWith(context);
		return Effect.flatten(
			Effect.promise((signal) => piWithFileMutationQueue(path, () => runExit(effect, { signal }))),
		);
	});
}

/**
 * Pi's bash operations over `env`, an execution environment of `@effectified/pi-env` (local, over SSH, a pi-env
 * daemon): with them in `bash`'s options, its commands run there, in the working directory Pi gives, with the
 * environment variables Pi gives. Interrupting the call (Pi's abort) kills the command; a timeout and an abort reach
 * Pi as its own local shell reports them.
 */
export function bashOperations(env: Env.Env): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env: variables }) =>
			Effect.runPromise(
				env
					.execOutput(command, {
						cwd,
						...(timeout === undefined ? {} : { timeout }),
						...(variables === undefined ? {} : { env: defined(variables) }),
					})
					.pipe(
						Stream.runFold(
							(): Awaited<ReturnType<BashOperations["exec"]>> => ({ exitCode: null }),
							(state, event) => {
								if (event.kind === "exited") return { exitCode: event.exitCode };
								onData(Buffer.from(event.text));
								return state;
							},
						),
						Effect.mapError((failure) =>
							failure.code === "timeout"
								? new Error(`timeout:${timeout}`)
								: failure.code === "aborted"
									? new Error("aborted")
									: new Error(failure.message),
						),
					),
				{ signal },
			),
	};
}

/** The variables of Node's environment shape that have a value. */
function defined(variables: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(variables).filter((entry): entry is [string, string] => Predicate.isString(entry[1])),
	);
}

/** `definition` and its agent tool as a `Builtin`. */
function builtin<D extends { readonly name: string; readonly execute: Execute }, T>(
	definition: D,
	agentTool: () => T,
): Builtin<D, T> {
	return {
		name: definition.name,
		pi: definition,
		// A built-in definition is a definition whose parameters are its own schema: Pi's factories type them exactly.
		definition: Effect.succeed(definition as unknown as ToolDefinition),
		agentTool: Effect.sync(agentTool),
		run: (params, toolCallId = definition.name) =>
			Effect.tryPromise({
				// Pi's built-in tools run without a context outside a session (their execute takes it as optional); the
				// definition type requires one.
				try: (signal) => definition.execute(toolCallId, params, signal, undefined, undefined as never),
				catch: fromPi,
			}) as Effect.Effect<Awaited<ReturnType<D["execute"]>>, CodingAgentFailure>,
	};
}
