// Hooks in Effect: the questions Pi's built-in tasks ask extension code, each answered by an Effect.

import {
	type CompactionHooks,
	CompactionTask,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type GenerationHooks,
	GenerationTask,
	type HookRegistration,
	hook,
	type HookApi as PiHookApi,
	type TaskId,
	type ToolHooks,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Option, type Schema, type Stream } from "effect";
import { call } from "./call.ts";
import * as Doc from "./doc.ts";
import * as Entries from "./entries.ts";
import * as Entry from "./entry.ts";
import type { DurableError } from "./errors.ts";
import * as Gate from "./gate.ts";
import { built, type Invoke, invoker } from "./invocation.ts";
import * as Memo from "./memo.ts";
import * as Signal from "./signal.ts";

export {
	AfterToolsDecision,
	continueWith,
	proceed,
	stand,
	type TaskRequest,
	task,
	terminate,
	UserInput,
	YieldDecision,
} from "./hook-task.ts";

/** A hook made by one of this module's constructors: what an extension holds and a registry installs. */
export interface Hook<R> {
	/** Builds Pi's hook; its handler runs with the context this Effect is run in (`Registry.layer` runs it). */
	readonly registration: Effect.Effect<HookRegistration, never, R>;
}

/** Any hook, whatever its handler needs. */
export interface Any {
	readonly registration: Effect.Effect<HookRegistration, never, unknown>;
}

/** The services a hook, or each hook of a union, needs to run. */
export type Services<H> = H extends { readonly registration: Effect.Effect<infer _A, infer _E, infer R> } ? R : never;

/**
 * What a handler may use besides its arguments: committed reads and the memos of the task that asks. A hook gets no
 * commit: it answers, and the asking task commits the decision. Pi may ask again after a crash or a wake, so what a
 * handler does outside must be idempotent. `snapshot` and `snapshotAsOf` read documents as committed when they run.
 */
export interface Api extends Doc.Reader {
	/** The task that asks: a generation, a tool call or a compaction. `Harness.signal` delivers to it. */
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	/** The harness clock, in epoch milliseconds: what `Gate.park`'s `until` is compared with. */
	readonly now: Effect.Effect<number>;
	/**
	 * A memo of the asking task, which hooks and the task share, so prefix the name. With a candidate, the first
	 * writer wins and every later call gets its value: a decision that must not change when Pi asks again.
	 */
	readonly memo: Memo.Memo;
	/** The committed state of a signal key in the asking task: none while nothing came. It never waits. */
	readonly readSignal: <S extends Schema.Constraint>(
		signal: Signal.Signal<S>,
		key: string,
	) => Effect.Effect<Option.Option<Signal.State<S["Type"]>>, DurableError | Signal.Failure, S["DecodingServices"]>;
	/** A committed entry visible from the task's conversation. */
	readonly entry: (id: EntryId) => Effect.Effect<Option.Option<EntryRecord>, DurableError>;
	/** That entry as one of `entry`'s kind, its data decoded: none when it is absent or has another kind. */
	readonly entryOf: <S extends Schema.Constraint>(
		entry: Entry.Entry<S>,
		id: EntryId,
	) => Effect.Effect<Option.Option<Entry.Typed<S["Type"]>>, DurableError | SchemaDecodeError, S["DecodingServices"]>;
	/** The committed raw history of the task's conversation, which compaction never changes. */
	readonly entries: (query?: Entries.EntriesQuery) => Stream.Stream<EntryRecord, DurableError>;
	/** Pi's own api, for what this package does not wrap: the models. */
	readonly pi: PiHookApi;
}

/** What a hook answers instead of nothing: the value Pi's hook of that name may return. */
export type Answer<H extends (...args: never) => unknown> = NonNullable<Awaited<ReturnType<H>>>;

/**
 * Before every model request attempt: `Option.some` replaces the messages of that request only. A failure is
 * reported and skipped, as for every hook but `beforeTool`: the request goes out as the hooks before it left it.
 */
export function beforeRequest<E, R>(
	handler: (
		request: Parameters<GenerationHooks["beforeRequest"]>[0],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<GenerationHooks["beforeRequest"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			beforeRequest: (request, api, context) =>
				ask(invoke, "beforeRequest", api, context, (hookApi) => answered(handler(request, hookApi))),
		}),
	);
}

/**
 * After pi-ai built the provider request body, before it is sent: `Option.some` replaces the body, which is in the
 * provider API's own format (`request.model.api`), for that request only.
 */
export function beforeProviderRequest<E, R>(
	handler: (
		request: Parameters<GenerationHooks["beforeProviderRequest"]>[0],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<GenerationHooks["beforeProviderRequest"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			beforeProviderRequest: (request, api, context) =>
				ask(invoke, "beforeProviderRequest", api, context, (hookApi) => answered(handler(request, hookApi))),
		}),
	);
}

/** Observes every terminal provider message, an error or an aborted one too, before Pi classifies it. */
export function afterResponse<E, R>(
	handler: (message: Parameters<GenerationHooks["afterResponse"]>[0], api: Api) => Effect.Effect<void, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			afterResponse: (message, api, context) =>
				ask(invoke, "afterResponse", api, context, (hookApi) => handler(message, hookApi)),
		}),
	);
}

/**
 * At a final answer; the first hook that answers wins. `continue` appends a user message and continues the run;
 * `tasks` (made by `task`) decide whether the answer stands, each completing with a `YieldDecision`.
 */
export function onYield<E, R>(
	handler: (
		answer: Parameters<GenerationHooks["onYield"]>[0],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<GenerationHooks["onYield"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			onYield: (answer, api, context) =>
				ask(invoke, "onYield", api, context, (hookApi) => answered(handler(answer, hookApi))),
		}),
	);
}

/**
 * Once every tool of a round is done: `assistant` is the entry that called them, `results` their result entries in
 * call order. `Option.some` asks for tasks (made by `task`) to run before the round ends, each completing with an
 * `AfterToolsDecision`.
 */
export function afterTools<E, R>(
	handler: (
		assistant: EntryId,
		results: ReadonlyArray<EntryId>,
		api: Api,
	) => Effect.Effect<Option.Option<Answer<GenerationHooks["afterTools"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			afterTools: (assistant, results, api, context) =>
				ask(invoke, "afterTools", api, context, (hookApi) => answered(handler(assistant, results, hookApi))),
		}),
	);
}

/**
 * After a run answered and its inputs settled: `Option.some` asks for tasks (made by `task`) the run waits for
 * before it ends. Never after a failure or an abort.
 */
export function afterRun<E, R>(
	handler: (
		run: Parameters<GenerationHooks["afterRun"]>[0],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<GenerationHooks["afterRun"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(GenerationTask, {
			afterRun: (run, api, context) =>
				ask(invoke, "afterRun", api, context, (hookApi) => answered(handler(run, hookApi))),
		}),
	);
}

/**
 * Before a compaction summarizes the range it selected; the first hook that answers wins: `decline` the compaction,
 * or give the `summary` yourself.
 */
export function beforeCompact<E, R>(
	handler: (
		compaction: Parameters<CompactionHooks["beforeCompact"]>[0],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<CompactionHooks["beforeCompact"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(CompactionTask, {
			beforeCompact: (compaction, api, context) =>
				ask(invoke, "beforeCompact", api, context, (hookApi) => answered(handler(compaction, hookApi))),
		}),
	);
}

/**
 * Before a tool call runs, the model's and a nested one (`call.parent`): the handler decides with a `Gate`. A
 * failure blocks the call with the error's message, so a gate fails closed.
 */
export function beforeTool<E, R>(
	handler: (call: Parameters<ToolHooks["beforeTool"]>[0], api: Api) => Effect.Effect<Gate.Gate, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(ToolTask, {
			beforeTool: (toolCall, api, context) =>
				ask(
					invoke,
					"beforeTool",
					api,
					context,
					(hookApi) => Effect.flatMap(handler(toolCall, hookApi), Gate.toPi),
					{
						tool: toolCall.name,
						callId: toolCall.id,
					},
				),
		}),
	);
}

/**
 * Before a tool call's result is committed: `Option.some` replaces it. Sees every result a tool task writes, also
 * the error results Pi writes itself (blocked, invalid, interrupted, aborted), told apart by their diagnostic code.
 */
export function afterTool<E, R>(
	handler: (
		call: Parameters<ToolHooks["afterTool"]>[0],
		result: Parameters<ToolHooks["afterTool"]>[1],
		api: Api,
	) => Effect.Effect<Option.Option<Answer<ToolHooks["afterTool"]>>, E, R>,
): Hook<R> {
	return registered((invoke) =>
		hook(ToolTask, {
			afterTool: (toolCall, result, api, context) =>
				ask(invoke, "afterTool", api, context, (hookApi) => answered(handler(toolCall, result, hookApi)), {
					tool: toolCall.name,
					callId: toolCall.id,
				}),
		}),
	);
}

/** A hook whose Pi registration `build` makes, with an `Invoke` on the context the registration is run in. */
function registered<R>(build: (invoke: Invoke<R>) => HookRegistration): Hook<R> {
	return { registration: Effect.map(Effect.context<R>(), (context) => build(invoker(built(context)))) };
}

/**
 * Runs a handler for one ask of Pi, with the api for that ask, in a span of its own that names the hook, the asking
 * task and its conversation (and `attributes`). A hook is asked once per step of a conversation, never per token. A
 * throw of `handler` is a defect.
 */
function ask<A, E, R>(
	invoke: Invoke<R>,
	name: string,
	api: PiHookApi,
	invocation: ChordContext,
	handler: (api: Api) => Effect.Effect<A, E, R>,
	attributes?: { readonly [attribute: string]: string },
): Promise<A> {
	const hookApi = fromPi(api, invocation);
	return invoke(
		Effect.withSpan(
			Effect.suspend(() => handler(hookApi)),
			`Hook.${name}`,
			{
				attributes: { hook: name, taskId: api.taskId, conversationId: api.conversationId, ...attributes },
			},
		),
		invocation,
	);
}

/** A handler's answer as Pi reads it: the value, or `undefined` for none. */
function answered<A, E, R>(answer: Effect.Effect<Option.Option<A>, E, R>): Effect.Effect<A | undefined, E, R> {
	return Effect.map(answer, Option.getOrUndefined);
}

/** The Effect form of the api Pi gives a hook; its Pi calls run under `invocation`, the hook's own context. */
function fromPi(api: PiHookApi, invocation: ChordContext): Api {
	const entry = Effect.fn("HookApi.entry")(function* (id: EntryId) {
		const found = yield* call((context) => api.entry(id, context), invocation);
		return Option.fromNullishOr(found);
	});
	return {
		...Doc.reader(api, invocation),
		taskId: api.taskId,
		conversationId: api.conversationId,
		now: Effect.sync(() => api.now()),
		memo: Memo.fromPi(api, invocation),
		readSignal: (signal, key) => Signal.read(api, signal, key, invocation),
		entry,
		entryOf: (kind, id) => Entry.typed(kind, entry(id)),
		entries: (query) => Entries.stream((...page) => api.entries(...page), query, invocation),
		pi: api,
	};
}
