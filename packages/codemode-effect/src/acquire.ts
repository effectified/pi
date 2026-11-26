// Pi's sandboxes as `Sandbox` handles: the constructor every kind of sandbox shares, which makes the tools, owns Pi's
// sandbox for a scope and lifts its methods into Effects.

import type { CodemodeResult, CodemodeSandboxBase, CodemodeTool } from "@earendil-works/pi-codemode/portable";
import type { SchemaConversionError } from "@effectified/pi-agent";
import { Effect, type Scope } from "effect";
import { messageOf, type RunRejected, SandboxClosed, ToolRejected } from "./errors.ts";
import * as Run from "./run.ts";
import type { Options, Sandbox } from "./sandbox.ts";
import * as ScriptTool from "./script-tool.ts";

/**
 * The sandbox Pi's `construct` makes of the tools and globals, closed when the scope closes. For the constructors of
 * each kind of sandbox; the tools' handlers run with the services of the context this Effect runs in.
 */
export function acquire<R>(
	options: Options<R>,
	construct: (tools: CodemodeTool[], globals: CodemodeTool[]) => CodemodeSandboxBase,
): Effect.Effect<Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> {
	return Effect.gen(function* () {
		const tools = yield* Effect.forEach(options.tools ?? [], ScriptTool.fromAgent);
		const globals = yield* Effect.forEach(options.globals ?? [], ScriptTool.global);
		const state = { closed: false };
		const pi = yield* Effect.acquireRelease(
			Effect.try({ try: () => construct(tools, globals), catch: rejected }),
			(pi) =>
				Effect.promise(() => {
					state.closed = true;
					return pi.close();
				}),
		);
		return wrap(pi, state);
	});
}

/** Pi's sandbox as a `Sandbox`. `state.closed`: its scope closed it. */
function wrap(pi: CodemodeSandboxBase, state: { readonly closed: boolean }): Sandbox {
	return {
		pi,
		tools: Effect.sync(() => pi.tools),
		globals: pi.globals,
		register: (tool) =>
			Effect.flatMap(ScriptTool.fromAgent(tool), (codemodeTool) =>
				Effect.try({ try: () => pi.registerTool(codemodeTool), catch: rejected }),
			),
		unregister: (name) => Effect.sync(() => pi.unregisterTool(name)),
		execute: (code, options) => abortable((signal) => pi.execute(code, { ...options, signal })),
		start: (code, options) =>
			Effect.suspend(
				(): Effect.Effect<Run.Run, SandboxClosed | RunRejected, Scope.Scope> =>
					state.closed ? Effect.fail(closed(CLOSED)) : Run.start(pi, code, options),
			),
	};
}

/** Pi's text for a closed sandbox, which `start` throws and `execute` rejects with. */
const CLOSED = "Sandbox is closed";

/**
 * Runs an execution with the fiber's abort signal: interrupting the fiber aborts it and waits until Pi settled it. Pi
 * rejects an execution only when the sandbox is closed.
 */
function abortable(
	run: (signal: AbortSignal) => Promise<CodemodeResult>,
): Effect.Effect<CodemodeResult, SandboxClosed> {
	return Effect.callback<CodemodeResult, SandboxClosed>((resume, signal) => {
		const done = run(signal).then(
			(result) => resume(Effect.succeed(result)),
			(cause: unknown) => resume(Effect.fail(closed(messageOf(cause)))),
		);
		return Effect.promise(() => done);
	});
}

function closed(message: string): SandboxClosed {
	return new SandboxClosed({ message });
}

function rejected(cause: unknown): ToolRejected {
	return new ToolRejected({ message: messageOf(cause) });
}
