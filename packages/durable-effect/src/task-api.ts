// The api a task's handlers get: an Effect view of what Pi Durable gives one invocation of one task.

import type {
	CommitOptions,
	ContextView,
	ConversationId,
	EntryId,
	EntryRecord,
	HookRunner,
	Agent as PiAgent,
	ReportFrom,
	RunningTask,
	SettledTask,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	WakeReason,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@effectified/pi-chord/json";
import type { SchemaConversionError, SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Option, Ref, type Schema, type Stream } from "effect";
import { call } from "./call.ts";
import * as Doc from "./doc.ts";
import * as Entries from "./entries.ts";
import * as Entry from "./entry.ts";
import type { DurableError } from "./errors.ts";
import { invoker } from "./invocation.ts";
import * as Memo from "./memo.ts";
import * as Signal from "./signal.ts";
import type * as Task from "./task.ts";
import type * as TaskHooks from "./task-hooks.ts";
import * as Step from "./task-step.ts";
import * as ToolApi from "./tool-api.ts";
import * as Tx from "./tx.ts";
import type * as Watch from "./watch.ts";

/** The task a handler runs for, as its phase finds it: the input and the state decoded. */
export interface Running<I, S> {
	readonly id: TaskId;
	readonly conversationId: ConversationId;
	readonly input: I;
	/** The checkpoint the task stands at. A phase handler gets the member of the state union its phase names. */
	readonly state: S;
	/** Why the task woke from the sleep or the wait that led to this state; none otherwise. A rerun reads the same. */
	readonly wake: Option.Option<WakeReason>;
	/** Pi's own record: the stored input and checkpoint, the owner, `restarts`, the abort mark and its reason. */
	readonly record: Record;
}

/** Pi's record of a running task of this package: input, checkpoint and result as stored JSON. */
export type Record = RunningTask<JsonValue, Step.Checkpoint, JsonValue>;

/** Pi's runtime of one invocation of a task of this package. */
export interface Runtime extends TaskRuntime<JsonValue, Step.Checkpoint, JsonValue, object> {}

/** What a task's own commit fails with besides Pi's failures: a state, a result or a signal that cannot be stored. */
export type Failure = SchemaDecodeError | SchemaConversionError;

/** What the body of `commitReturning` returns: the task's step, and a value for the phase to go on with. */
export interface Returning<S, A, B> {
	readonly step: Step.Step<S, A> | Step.Unchanged;
	readonly value: B;
}

/**
 * What a handler may use besides its task, for one invocation. Every operation fails once the invocation ended. Pi
 * runs a phase again from its top after a crash or a close that came before its step was committed, so what a phase
 * does outside must be idempotent: fix its keys in a memo, or in the state of the phase before.
 */
export interface Api<I, S, A> extends Doc.Reader {
	/** This task: `Harness.signal` delivers to it, and children and conversations it creates are owned by it. */
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	/** The harness clock, in epoch milliseconds: what a sleep's `until` is compared with. */
	readonly now: Effect.Effect<number>;
	/** What the task's conversation runs with, resolved once per phase. */
	readonly agent: Effect.Effect<PiAgent, DurableError>;
	/**
	 * A commit of this task, with `Tx`'s rules. The step the body returns replaces the task's state in the same commit,
	 * so it is stored together with the entries, documents and child tasks the body wrote, or not at all;
	 * `Task.unchanged` stores only those. `current` is the task as Pi reread it for the commit. Entries the body appends
	 * carry the task's id, and `tx.createTask` defaults to the task's conversation. Pi rejects the commit when the task
	 * ended, the invocation ended, the harness is closing, or, outside the abort handler, the task was marked for abort.
	 * A sleep or a wait ends the invocation: return right after it.
	 */
	readonly commit: <E, R>(
		change: (tx: Tx.Tx, current: Running<I, S>) => Effect.Effect<Step.Step<S, A> | Step.Unchanged, E, R>,
		options?: CommitOptions,
	) => Effect.Effect<Step.Committed, E | DurableError | Failure, R>;
	/**
	 * `commit` whose body also returns a value: it succeeds with that value once the commit, which stores the step with
	 * the body's other writes, is stored. For what the body read or created and the phase needs afterwards, such as a
	 * count it scanned or the ids of the children it created. A phase that committed its step so returns
	 * `Task.committed`.
	 */
	readonly commitReturning: <B, E, R>(
		change: (tx: Tx.Tx, current: Running<I, S>) => Effect.Effect<Returning<S, A, B>, E, R>,
		options?: CommitOptions,
	) => Effect.Effect<B, E | DurableError | Failure, R>;
	/** A memo of this task, kept while it can run: with a candidate, the first writer wins. A commit of its own. */
	readonly memo: Memo.Memo;
	/** The committed state of a signal key in this task: none while nothing came. It never waits. */
	readonly readSignal: <K extends Schema.Constraint>(
		signal: Signal.Signal<K>,
		key: string,
	) => Effect.Effect<Option.Option<Signal.State<K["Type"]>>, DurableError | Signal.Failure, K["DecodingServices"]>;
	/** The committed record of any task. */
	readonly getTask: <R>(
		id: TaskId<R>,
	) => Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, R>>, DurableError>;
	/**
	 * Succeeds with a task's terminal record once it ended. It holds this invocation meanwhile: to wait without a
	 * process, end the phase with `Task.wait`.
	 */
	readonly waitForTask: <R>(id: TaskId<R>) => Effect.Effect<SettledTask<R>, DurableError>;
	/** Aborts a task this task owns and succeeds once it ended; fails for a task another owns. */
	readonly abortOwned: (id: TaskId) => Effect.Effect<void, DurableError>;
	/** The live tasks this task owns directly, in id order, whichever invocation created them. */
	readonly ownedTasks: Effect.Effect<ReadonlyArray<TaskRecord<JsonValue, JsonValue, JsonValue>>, DurableError>;
	/** The outcomes of ended tasks, in order, as stored; fails when one is missing or has not ended. For after a wait. */
	readonly outcomes: <R>(ids: ReadonlyArray<TaskId<R>>) => Effect.Effect<ReadonlyArray<TaskOutcome<R>>, DurableError>;
	/** `outcomes` of tasks of `task`'s kind, their results decoded. */
	readonly outcomesOf: <B>(
		task: Task.Kind<never, B>,
		ids: ReadonlyArray<TaskId>,
	) => Effect.Effect<ReadonlyArray<TaskOutcome<B>>, DurableError | SchemaDecodeError>;
	/** A handle for an existing conversation, such as one this task owns; bound to this invocation. */
	readonly conversation: (id: ConversationId) => Effect.Effect<Option.Option<ToolApi.Handle>, DurableError>;
	/** A committed entry visible from the task's conversation. */
	readonly entry: (id: EntryId) => Effect.Effect<Option.Option<EntryRecord>, DurableError>;
	/** That entry as one of `entry`'s kind, its data decoded: none when it is absent or has another kind. */
	readonly entryOf: <K extends Schema.Constraint>(
		entry: Entry.Entry<K>,
		id: EntryId,
	) => Effect.Effect<Option.Option<Entry.Typed<K["Type"]>>, DurableError | SchemaDecodeError, K["DecodingServices"]>;
	/** The committed raw history of the task's conversation, which compaction never changes. */
	readonly entries: (query?: Entries.EntriesQuery) => Stream.Stream<EntryRecord, DurableError>;
	/** The active transcript and the model context of a conversation, as of now or of the entry `at`. */
	readonly context: (
		conversationId: ConversationId,
		options?: { readonly at?: EntryId },
	) => Effect.Effect<ContextView, DurableError>;
	/** Hands a failure that does not fail the task to the harness's reports (`task_error`, or as `from` says). */
	readonly report: (error: unknown, from?: ReportFrom) => Effect.Effect<void>;
	/**
	 * Asks this task's own hook `name` of every extension the conversation selects that answers `hooks` (made for this
	 * task's kind), in extension order: `ask` runs with each answer. A failure of `ask` is reported and the next answer
	 * is asked, so a hook fails open; the Effect fails only when the invocation is aborted.
	 */
	readonly eachHook: <H extends TaskHooks.Handlers, K extends keyof H & string, E, R>(
		hooks: TaskHooks.TaskHooks<H>,
		name: K,
		ask: (handler: H[K]) => Effect.Effect<void, E, R>,
	) => Effect.Effect<void, DurableError, R>;
	/**
	 * Succeeds once about `millis` passed on the harness's timer (Pi's `setTimer`, so the harness's `Clock`), for pacing
	 * work inside a phase, such as throttled progress commits. Not durable: interrupting it disarms the timer, and so
	 * does the end of the invocation. To wait between phases without a process, end the phase with a sleep.
	 */
	readonly timer: (millis: number) => Effect.Effect<void>;
	/**
	 * Pi's `watchDoc` from inside the task, as a Stream of decoded values (see `Harness.watchDoc`). It stops at the end
	 * of the invocation, and when the stream's scope closes.
	 */
	readonly watchDoc: <D extends Doc.Any>(
		doc: D,
		...address: Doc.Address<D>
	) => Stream.Stream<Watch.Change<Doc.Value<D>>, Doc.Failure>;
	/**
	 * Pi's own runtime, for what this package does not wrap: the models (`models`), the settings, the registry
	 * snapshot, the environment, `signal`, its abort signal.
	 */
	readonly pi: Runtime;
}

/** How a task's stored JSON becomes the values its handlers get, and back. */
export interface Codec<I, S, A> extends Step.Encoders<S, A> {
	readonly input: (stored: JsonValue) => Effect.Effect<I, SchemaDecodeError>;
	readonly checkpoint: (stored: JsonValue) => Effect.Effect<S, SchemaDecodeError>;
}

/** Pi's record of a running task as a handler gets it. */
export function running<I, S, A>(
	record: Record,
	codec: Codec<I, S, A>,
): Effect.Effect<Running<I, S>, SchemaDecodeError> {
	return Effect.all([codec.input(record.input), codec.checkpoint(record.state.checkpoint)], { concurrency: 1 }).pipe(
		Effect.map(([input, state]) => ({
			id: record.id,
			conversationId: record.conversationId,
			input,
			state,
			wake: Option.fromUndefinedOr(record.state.wake),
			record,
		})),
	);
}

/** The Effect form of the runtime Pi gives a task's handler. Its Pi calls run under the handler's `ParentContext`. */
export function fromPi<I, S, A>(runtime: Runtime, codec: Codec<I, S, A>): Api<I, S, A> {
	const entry = Effect.fn("TaskApi.entry")(function* (id: EntryId) {
		const found = yield* call((context) => runtime.entry(id, context));
		return Option.fromUndefinedOr(found);
	});
	const outcomes = Effect.fn("TaskApi.outcomes")(function* <R>(ids: ReadonlyArray<TaskId<R>>) {
		return yield* call((context) => runtime.outcomes(ids, context));
	});
	return {
		...Doc.reader(runtime),
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		now: Effect.sync(() => runtime.now()),
		agent: call((context) => runtime.agent(context)),
		commit: Effect.fn("TaskApi.commit")(function* <E, R>(
			change: (tx: Tx.Tx, current: Running<I, S>) => Effect.Effect<Step.Step<S, A> | Step.Unchanged, E, R>,
			options?: CommitOptions,
		) {
			yield* Tx.during<void, E | Failure, R>((inside, context) =>
				runtime.commit(
					(tx, current) =>
						inside(tx, (transaction) =>
							running(current, codec).pipe(
								Effect.flatMap((task) => change(transaction, task)),
								Effect.flatMap((step) => Step.toPi(step, codec)),
							),
						),
					context,
					options,
				),
			);
			return Step.committed;
		}),
		commitReturning: Effect.fn("TaskApi.commitReturning")(function* <B, E, R>(
			change: (tx: Tx.Tx, current: Running<I, S>) => Effect.Effect<Returning<S, A, B>, E, R>,
			options?: CommitOptions,
		) {
			// Pi's commit resolves with nothing: the body's value leaves through here.
			const returned = yield* Ref.make(Option.none<B>());
			yield* Tx.during<void, E | Failure, R>((inside, context) =>
				runtime.commit(
					(tx, current) =>
						inside(tx, (transaction) =>
							running(current, codec).pipe(
								Effect.flatMap((task) => change(transaction, task)),
								Effect.tap(({ value }) => Ref.set(returned, Option.some(value))),
								Effect.flatMap(({ step }) => Step.toPi(step, codec)),
							),
						),
					context,
					options,
				),
			);
			const value = yield* Ref.get(returned);
			// Pi stores the commit only after the body succeeded, which set the value.
			if (Option.isNone(value))
				return yield* Effect.die(new Error("Pi stored a task commit whose body gave no value"));
			return value.value;
		}),
		memo: Memo.fromPi(runtime),
		readSignal: (signal, key) => Signal.read(runtime, signal, key),
		getTask: Effect.fn("TaskApi.getTask")(function* <R>(id: TaskId<R>) {
			const found = yield* call((context) => runtime.getTask(id, context));
			return Option.fromUndefinedOr(found);
		}),
		waitForTask: Effect.fn("TaskApi.waitForTask")(function* <R>(id: TaskId<R>) {
			return yield* call((context) => runtime.waitForTask(id, context));
		}),
		abortOwned: Effect.fn("TaskApi.abortOwned")(function* (id: TaskId) {
			return yield* call((context) => runtime.abortOwned(id, context));
		}),
		ownedTasks: call((context) => runtime.ownedTasks(context)),
		outcomes,
		outcomesOf: Effect.fn("TaskApi.outcomesOf")(function* <B>(task: Task.Kind<never, B>, ids: ReadonlyArray<TaskId>) {
			const stored = yield* outcomes(ids);
			return yield* Effect.forEach(stored, task.outcome, { concurrency: 1 });
		}),
		conversation: Effect.fn("TaskApi.conversation")(function* (id: ConversationId) {
			const found = yield* call((context) => runtime.conversation(id, context));
			return Option.map(Option.fromUndefinedOr(found), ToolApi.handle);
		}),
		entry,
		entryOf: (kind, id) => Entry.typed(kind, entry(id)),
		entries: (query) => Entries.stream((...page) => runtime.entries(...page), query),
		context: Effect.fn("TaskApi.context")(function* (
			conversationId: ConversationId,
			options?: { readonly at?: EntryId },
		) {
			return yield* call((context) => runtime.context(conversationId, context, options));
		}),
		report: (error, from) => Effect.sync(() => runtime.report(error, from)),
		eachHook: Effect.fn("TaskApi.eachHook")(function* <
			H extends TaskHooks.Handlers,
			K extends keyof H & string,
			E,
			R,
		>(_hooks: TaskHooks.TaskHooks<H>, name: K, ask: (handler: H[K]) => Effect.Effect<void, E, R>) {
			const services = yield* Effect.context<R>();
			const invoke = invoker(services);
			// Pi types a task's own hooks by its definition, which this package leaves open (`object`): `hooks`, made
			// for this task's kind, types the answers the registry holds for it.
			const runner = runtime.hooks as unknown as HookRunner<H>;
			return yield* call((invocation) => runner.each(name, (handler) => invoke(ask(handler), invocation)));
		}),
		timer: (millis) =>
			Effect.callback<void>((resume) => {
				const disarm = runtime.setTimer(() => resume(Effect.void), millis);
				return Effect.sync(disarm);
			}),
		watchDoc: (doc, ...address) => Doc.watch(runtime, doc, ...address),
		pi: runtime,
	};
}
