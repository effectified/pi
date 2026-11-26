// The api a tool handler gets: an Effect view of what Pi Durable gives one tool call.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	CommitOptions,
	ConversationAbortOptions,
	ConversationHandle,
	ConversationId,
	JsonObject,
	NestedToolCall,
	NestedToolExecutionResult,
	Agent as PiAgent,
	ToolExecutionApi as PiToolExecutionApi,
	SettledTask,
	SubmissionDraft,
	SubmissionId,
	TaskId,
	TaskRecord,
	ToolDiagnostic,
	WakeReason,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Option, type Schema } from "effect";
import { call } from "./call.ts";
import * as Doc from "./doc.ts";
import type { DurableError } from "./errors.ts";
import * as Memo from "./memo.ts";
import * as Signal from "./signal.ts";
import * as Submission from "./submission.ts";
import type * as Task from "./task.ts";
import * as Tx from "./tx.ts";

/**
 * What a handler may use besides its arguments, for one run of one call. Every operation fails once the handler
 * returned. Pi may run a `replay: "safe"` handler again after a crash, and runs every handler again after a park, so
 * what a handler does outside must be idempotent: fix its keys in a memo first.
 */
export interface Api extends Doc.Reader {
	/** The task of this call: `Harness.signal` delivers to it, and conversations it creates are owned by it. */
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	/** The id the model gave the call; a nested call's is `<caller's id>/<key>`. */
	readonly callId: string;
	/** Why this run started after a park (`Tool.sleep`, `Tool.wait`); none on a fresh call. */
	readonly wake: Option.Option<WakeReason>;
	/** What the call last parked with; none on a fresh call, or after a park without a checkpoint. */
	readonly checkpoint: Option.Option<JsonValue>;
	/** The harness clock, in epoch milliseconds: what a park's `until` is compared with. */
	readonly now: Effect.Effect<number>;
	/** What the calling conversation runs with, as the call's task resolved it. */
	readonly agent: Effect.Effect<PiAgent, DurableError>;
	/**
	 * A commit of this call's task, with `Tx`'s rules: entries it appends carry the task's id, and a conversation it
	 * creates with `ownership: { kind: "task", taskId }` is aborted with the call and keeps the caller busy.
	 */
	readonly commit: <A, E, R>(
		change: (tx: Tx.Tx) => Effect.Effect<A, E, R>,
		options?: CommitOptions,
	) => Effect.Effect<A, E | DurableError, R>;
	/** A memo of this call's task. */
	readonly memo: Memo.Memo;
	/** The committed state of a signal key in this call's task: none while nothing came. It never waits. */
	readonly readSignal: <S extends Schema.Constraint>(
		signal: Signal.Signal<S>,
		key: string,
	) => Effect.Effect<Option.Option<Signal.State<S["Type"]>>, DurableError | Signal.Failure, S["DecodingServices"]>;
	/**
	 * A new task of `task`'s kind with `input`, encoded, in a commit of its own, and its id. With a `key`, the task is
	 * recorded under it in that commit, and a later call with the key, in this run, a rerun or a run after a wake, gives
	 * that task instead of a second one; another kind, another input, or a key a nested call uses fails. After a wake a
	 * key is required. A child (`ownership: { kind: "task", taskId: api.taskId }`) of a tool that is not replay-safe
	 * is abandoned when a restart cuts the call off, since nothing waits for it then.
	 */
	readonly createTask: <I, A>(
		task: Task.Kind<I, A>,
		input: NoInfer<I>,
		options: CreateTaskOptions,
	) => Effect.Effect<TaskId, DurableError | SchemaDecodeError>;
	/** The committed record of any task; a task's `outcome` decodes its result. */
	readonly getTask: <R>(
		id: TaskId<R>,
	) => Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, R>>, DurableError>;
	/**
	 * Succeeds with a task's terminal record once it ended. It holds this call's run meanwhile: to wait without a
	 * process, return `Tool.wait` on the task.
	 */
	readonly waitForTask: <R>(id: TaskId<R>) => Effect.Effect<SettledTask<R>, DurableError>;
	/** A handle for an existing conversation, such as one this call created in `commit`; bound to this run. */
	readonly conversation: (id: ConversationId) => Effect.Effect<Option.Option<Handle>, DurableError>;
	/**
	 * Runs the tool `name` as a nested call of this one and waits for its result: its own task, owned by this call, with
	 * its hooks, limits and replay policy. A call that is blocked, invalid, fails or is aborted gives an `isError`
	 * result, not a failure. Interrupting the wait leaves the nested call running. After a wake a `key` is required.
	 */
	readonly executeTool: (
		name: string,
		args: JsonObject,
		options?: NestedOptions,
	) => Effect.Effect<NestedToolExecutionResult, DurableError>;
	/** Starts the nested call, or finds the one already made under its key, without waiting: to park on its `taskId`. */
	readonly startTool: (
		name: string,
		args: JsonObject,
		options?: NestedOptions,
	) => Effect.Effect<Started, DurableError>;
	/** Records a remark about this call that the model and a UI read; never part of the tool's data. */
	readonly diagnostic: (diagnostic: ToolDiagnostic) => Effect.Effect<void>;
	/**
	 * Replaces the running details, which a UI watching the call sees at once; the last value becomes the result's
	 * details unless the result gives its own. The model never reads details.
	 */
	readonly details: (value: Schema.Json) => Effect.Effect<void, DurableError>;
	/**
	 * Pi's own api, for what this package does not wrap: running output (`output`, `retainedOutput`), document
	 * watches, the environment and the models.
	 */
	readonly pi: PiToolExecutionApi;
}

/**
 * How a tool call creates a task: Pi's options of a tool's `createTask`, the task options without the conversation,
 * which is the call's, and with the `key`.
 */
export type CreateTaskOptions = Parameters<PiToolExecutionApi["createTask"]>[2];

/**
 * How a nested call is made: Pi's options of `executeTool` without `wait`, which `executeTool` and `startTool` choose.
 * Its `key` within this call (default: its position), and whether its `progress` is shown.
 */
export type NestedOptions = StrictOmit<Parameters<PiToolExecutionApi["executeTool"]>[3], "wait">;

/**
 * A nested call started without waiting for it: Pi's `NestedToolCall`, each method that takes a context as an Effect.
 * `taskId` is the nested call's task, what `Tool.wait` waits on; `result` is the stored result once the call ended,
 * and waits until then.
 */
export type Started = {
	readonly [K in keyof NestedToolCall]: NestedToolCall[K] extends (context: ChordContext) => Promise<infer A>
		? Effect.Effect<A, DurableError>
		: NestedToolCall[K];
};

/** A conversation as a tool call may drive it: any conversation, such as a subagent's. Bound to the run that got it. */
export interface Handle {
	readonly id: ConversationId;
	/** Durably admits input, a write or a continue; succeeds at admission with a submission to wait for. */
	readonly submit: (draft: SubmissionDraft) => Effect.Effect<Submission.Submission, DurableError>;
	/** Admits a submission inside the caller's commit, before its first table write, and gives its id. */
	readonly admit: (tx: Tx.Tx, draft: SubmissionDraft) => Effect.Effect<SubmissionId, DurableError>;
	/** Withdraws queued inputs, aborts the conversation's work, and succeeds once it is idle. */
	readonly abort: (options?: ConversationAbortOptions) => Effect.Effect<void, DurableError>;
	/** Succeeds once the conversation has no live work. */
	readonly waitForIdle: Effect.Effect<void, DurableError>;
}

/** The Effect form of the api Pi gives a tool call. Its Pi calls run under the `ParentContext` of the handler. */
export function fromPi(api: PiToolExecutionApi): Api {
	return {
		...Doc.reader(api),
		taskId: api.taskId,
		conversationId: api.conversationId,
		callId: api.callId,
		wake: Option.fromUndefinedOr(api.wake),
		checkpoint: Option.fromUndefinedOr(api.checkpoint),
		now: Effect.sync(() => api.now()),
		agent: call((context) => api.agent(context)),
		commit: (change, options) =>
			Tx.commit((body, context, given) => api.commit(body, context, given), change, options),
		memo: Memo.fromPi(api),
		readSignal: (signal, key) => Signal.read(api, signal, key),
		createTask: (task, input, options) =>
			Effect.flatMap(task.encodeInput(input), (json) =>
				call((context) => api.createTask(task.token, json, options, context)),
			),
		getTask: (id) =>
			Effect.map(
				call((context) => api.getTask(id, context)),
				Option.fromUndefinedOr,
			),
		waitForTask: (id) => call((context) => api.waitForTask(id, context)),
		conversation: (id) =>
			Effect.map(
				call((context) => api.conversation(id, context)),
				(found) => Option.map(Option.fromUndefinedOr(found), handle),
			),
		executeTool: (name, args, options) => call((context) => api.executeTool(name, args, context, options)),
		startTool: (name, args, options) =>
			Effect.map(
				call((context) => api.executeTool(name, args, context, { ...options, wait: false })),
				(started): Started => ({
					taskId: started.taskId,
					result: call((context) => started.result(context)),
				}),
			),
		diagnostic: (diagnostic) => Effect.sync(() => api.diagnostic(diagnostic)),
		// A decode boundary: Effect types JSON read-only, Chord types the same values mutable.
		details: (value) => call((context) => api.details(value as JsonValue, context)),
		pi: api,
	};
}

/** The Effect form of Pi's conversation handle. */
export function handle(conversation: ConversationHandle): Handle {
	return {
		id: conversation.id,
		submit: (draft) =>
			Effect.map(
				call((context) => conversation.submit(draft, context)),
				Submission.fromPi,
			),
		admit: (tx, draft) => Tx.admit(conversation, tx, draft),
		abort: (options) => call((context) => conversation.abort(context, options)),
		waitForIdle: call((context) => conversation.waitForIdle(context)),
	};
}
