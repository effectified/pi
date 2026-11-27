// Pi's sandboxes as `Sandbox` handles: the constructor every kind of sandbox shares, which makes the tools, owns Pi's
// sandbox for a scope and lifts its methods into Effects.

import type { CodemodeResult, CodemodeSandboxBase, CodemodeTool } from "@earendil-works/pi-codemode/portable";
import type { SchemaConversionError, Tool, ToolName } from "@effectified/pi-agent";
import { type Cause, Clock, Effect, Queue, Ref, type Scope, Stream } from "effect";
import { DeliveryRejected, messageOf, RunRejected, SandboxClosed, ToolRejected } from "./errors.ts";
import * as Run from "./run.ts";
import type { ExecuteOptions, Options, Sandbox } from "./sandbox.ts";
import * as ScriptTool from "./script-tool.ts";

/**
 * The sandbox Pi's `construct` makes of the tools and globals, closed when the scope closes. For the constructors of
 * each kind of sandbox; the tools' handlers run with the services of the context this Effect runs in. Untraced: the
 * sandbox keeps that context for its tools as long as it lives, which a span of this Effect would not outlive; each
 * execution and each tool call has its own span.
 */
export const acquire: <R>(
	options: Options<R>,
	construct: (tools: CodemodeTool[], globals: CodemodeTool[]) => CodemodeSandboxBase,
) => Effect.Effect<Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> = Effect.fnUntraced(function* <R>(
	options: Options<R>,
	construct: (tools: CodemodeTool[], globals: CodemodeTool[]) => CodemodeSandboxBase,
): Effect.fn.Return<Sandbox, ToolRejected | SchemaConversionError, R | Scope.Scope> {
	const tools = yield* Effect.forEach(options.tools ?? [], ScriptTool.fromAgent, { concurrency: 1 });
	const globals = yield* Effect.forEach(options.globals ?? [], ScriptTool.global, { concurrency: 1 });
	const closed = yield* Ref.make(false);
	const pi = yield* Effect.acquireRelease(
		Effect.try({ try: () => construct(tools, globals), catch: rejected }),
		(pi) =>
			Effect.andThen(
				Ref.set(closed, true),
				Effect.promise(() => pi.close()),
			),
	);
	return wrap(pi, closed);
});

/** Pi's sandbox as a `Sandbox`. `closed`: its scope closed it. */
function wrap(pi: CodemodeSandboxBase, closed: Ref.Ref<boolean>): Sandbox {
	return {
		pi,
		tools: Effect.sync(() => pi.tools),
		globals: pi.globals,
		register: register(pi),
		unregister: Effect.fn("Sandbox.unregister")((name: ToolName) => Effect.sync(() => pi.unregisterTool(name))),
		execute: Effect.fn("Sandbox.execute")((code: string, options?: ExecuteOptions) =>
			abortable((signal) => pi.execute(code, { ...options, signal })),
		),
		start: Effect.fn("Sandbox.start")(function* (code: string, options: Run.Options) {
			// Pi throws its text for a closed sandbox from `start`: told apart here, it is `SandboxClosed`.
			if (yield* Ref.get(closed)) return yield* SandboxClosed.make({ message: CLOSED });
			return yield* start(pi, code, options);
		}),
	};
}

/** Pi's text for a closed sandbox, which `start` throws and `execute` rejects with. */
const CLOSED = "Sandbox is closed";

/**
 * `register` of `pi`: adds a tool for later executions. Untraced: the tool keeps this Effect's context for every call,
 * which a span of the registration would not outlive.
 */
function register(pi: CodemodeSandboxBase): Sandbox["register"] {
	return Effect.fnUntraced(function* <R>(
		tool: Tool.Any<R>,
	): Effect.fn.Return<void, ToolRejected | SchemaConversionError, R> {
		const codemodeTool = yield* ScriptTool.fromAgent(tool);
		yield* Effect.try({ try: () => pi.registerTool(codemodeTool), catch: rejected });
	});
}

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
			(cause: unknown) => resume(Effect.fail(SandboxClosed.make({ message: messageOf(cause) }))),
		);
		return Effect.promise(() => done);
	});
}

/**
 * Starts `code` on Pi's sandbox as a run of the scope: closing the scope aborts it and waits for its result. Its
 * events wait in an unbounded queue, which ends after the last one: Pi reports them all before the result settles.
 * Untraced: `Sandbox.start`, its one caller, has the span.
 */
const start = Effect.fnUntraced(function* (
	sandbox: CodemodeSandboxBase,
	code: string,
	options: Run.Options,
): Effect.fn.Return<Run.Run, RunRejected, Scope.Scope> {
	const startedAt = options.startedAt ?? (yield* Clock.currentTimeMillis);
	const events = yield* Queue.unbounded<Run.Event, Cause.Done>();
	// Finalizers run last-added first: the run's result is awaited after the scope's abort signal aborted the run.
	let settling: Promise<unknown> = Promise.resolve();
	yield* Effect.addFinalizer(() => Effect.promise(() => settling));
	const signal = yield* Effect.abortSignal;
	const run = yield* Effect.try({
		try: () =>
			sandbox.start(code, {
				...options,
				startedAt,
				signal,
				onStarted: (fingerprint) => Queue.offerUnsafe(events, Run.Event.cases.Started.make({ fingerprint })),
				onCall: (call) =>
					Queue.offerUnsafe(
						events,
						Run.Event.cases.Call.make({ call: { ...call, id: Run.CallId.make(call.id) } }),
					),
				onIdle: (seq, issued) => Queue.offerUnsafe(events, Run.Event.cases.Idle.make({ seq, issued })),
			}),
		catch: (cause) => RunRejected.make({ message: messageOf(cause), cause }),
	});
	settling = run.result;
	void run.result.then(() => Queue.endUnsafe(events));
	return {
		startedAt,
		events: Stream.fromQueue(events),
		result: Effect.promise(() => run.result),
		finished: Effect.sync(() => run.finished),
		deliver: Effect.fn("Run.deliver")(function* (answer: Run.Answer) {
			const now = answer.now ?? (yield* Clock.currentTimeMillis);
			yield* Effect.try({
				try: () => run.deliver(answer.seq, now, answer.id, answer.outcome),
				catch: (cause) => DeliveryRejected.make({ message: messageOf(cause), cause }),
			});
		}),
	};
});

/** What Pi threw for a tool or a global it refused. */
function rejected(cause: unknown): ToolRejected {
	return ToolRejected.make({ message: messageOf(cause), cause });
}
