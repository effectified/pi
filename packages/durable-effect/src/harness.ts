// The Pi Durable harness as a scoped service: opened by a Layer, closed with its scope, read through Effects.

import {
	type CommitOptions,
	type ConversationId,
	type ConversationOwnership,
	type ConversationRecord,
	type EntryId,
	type HarnessInspection,
	type HarnessOptions,
	Harness as PiHarness,
	type Report,
	type SettledTask,
	type SignalResult,
	type SubmissionId,
	type TaskGraph,
	type TaskId,
	type TaskRecord,
	UsageDoc,
	type UsageState,
	type Wake,
} from "@earendil-works/pi-durable";
import { Models } from "@effectified/pi-ai";
import { BACKGROUND_CONTEXT, type Context as ChordContext } from "@effectified/pi-chord/context";
import type { JsonValue } from "@effectified/pi-chord/json";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { type Cause, Context, Effect, FiberSet, Layer, Option, PubSub, Queue, type Schema, Stream } from "effect";
import * as Agent from "./agent.ts";
import { call } from "./call.ts";
import * as Conversation from "./conversation.ts";
import * as Doc from "./doc.ts";
import { type DurableError, fromRejection } from "./errors.ts";
import * as Idle from "./idle.ts";
import * as Init from "./init.ts";
import { invoker } from "./invocation.ts";
import { Registry } from "./registry.ts";
import * as Reports from "./report.ts";
import * as Scans from "./scans.ts";
import * as Signal from "./signal.ts";
import { HarnessStorage } from "./storage.ts";
import * as Submission from "./submission.ts";
import * as Task from "./task.ts";
import { clockOptions } from "./timers.ts";
import * as Tx from "./tx.ts";
import * as Watch from "./watch.ts";

/**
 * Pi's open harness. An interface of this package, because Pi exports its harness type only as an alias, which a
 * built declaration file cannot refer to.
 */
export interface Open extends PiHarness {}

/**
 * The open harness of this program. The service value is Pi's own object, for what this package does not wrap yet;
 * the functions of this module are the Effect way to use it.
 */
export class Harness extends Context.Service<Harness, Open>()("@effectified/pi-durable/Harness") {}

/** Options of `layer`. `R` is what `conversationCreated` needs: the Layer requires it. */
export interface Options<R = never> {
	/** Run policy shared by every conversation, or a function returning the current one; read at each use. */
	readonly settings?: HarnessOptions["settings"];
	/** Open as a viewer of a session another process drives: nothing is recovered, and every write is refused. */
	readonly readOnly?: HarnessOptions["readOnly"];
	/**
	 * Continue the work the last process left unfinished as soon as the harness is open (Pi's `resume()`). Default
	 * true; never for a read-only harness. With false, work continues at the first call that asks for progress.
	 */
	readonly resume?: boolean;
	/** Pi's telemetry adapter, passed on unchanged: content-free spans and metrics of admissions and task phases. */
	readonly telemetry?: HarnessOptions["telemetry"];
	/** How model requests identify the app to providers, passed on unchanged. */
	readonly identity?: HarnessOptions["identity"];
	/** Builds a conversation's execution environment at each use, passed on unchanged: Pi's own callback. */
	readonly env?: HarnessOptions["env"];
	/**
	 * Runs in every commit that creates or forks a conversation, a tool's own `tx.createConversation` included, after
	 * Pi's built-in documents: the place to give every conversation your documents. The conversation is a table write
	 * already, so table reads fail with `ReadAfterWrite`; documents work. A failure fails the creating commit.
	 */
	readonly conversationCreated?: (tx: Tx.Tx, conversation: ConversationRecord) => Effect.Effect<void, unknown, R>;
	/**
	 * The host wakes the process for sleeping tasks itself (Pi's `onWake`): Pi arms no timer for them, and every
	 * change of `wake` is an element of `wakes`. The host arms its own wake-up from it, such as an actor alarm, and
	 * runs `resume` when it fires. Never for a read-only harness.
	 */
	readonly hostWakes?: boolean;
}

/**
 * Opens a harness on the storage, models and registry of the context, and closes it, its storage included, when the
 * scope closes. Pi's clock and timers are Effect's `Clock`. Every report of Pi goes to the Effect logger of the
 * context the Layer is built in (see `reports`).
 */
export function layer<R = never>(
	options: Options<R> = {},
): Layer.Layer<Harness, DurableError, HarnessStorage | Models | Registry | R> {
	return Layer.effect(
		Harness,
		Effect.gen(function* () {
			const storage = yield* HarnessStorage;
			const models = yield* Models;
			const registry = yield* Registry;
			// Pi's timers and the report log lines are fibers of this scope, made before the harness opens: they are
			// interrupted after it closed, so none outlives the Layer, nor reaches a closed harness.
			const clock = yield* clockOptions;
			const fork = yield* FiberSet.makeRuntime();
			const services = yield* Effect.context<R>();
			const invoke = invoker(services);
			const seams = yield* Effect.acquireRelease(
				Effect.all({ reports: PubSub.unbounded<Report>(), wakes: Queue.unbounded<Wake, Cause.Done>() }),
				// Both end their streams; what a consumer has not taken yet is still its to take.
				({ reports, wakes }) => Effect.andThen(PubSub.shutdown(reports), Queue.end(wakes)),
			);
			const created = options.conversationCreated;
			const harness = yield* Effect.acquireRelease(
				call((context) =>
					PiHarness.open(
						storage,
						{
							models,
							registry,
							settings: options.settings,
							readOnly: options.readOnly,
							telemetry: options.telemetry,
							identity: options.identity,
							env: options.env,
							...clock,
							// Both run where Pi must not be held up or failed: they only hand the value on.
							onReport: (report) => {
								PubSub.publishUnsafe(seams.reports, report);
								fork(Reports.log(report));
							},
							...(options.hostWakes === true
								? { onWake: (wake) => void Queue.offerUnsafe(seams.wakes, wake) }
								: {}),
							...(created === undefined
								? {}
								: {
										// Pi gives this callback no context: the creating commit is its scope.
										conversationCreated: (tx, conversation) =>
											invoke(created(Tx.fromPi(tx), conversation), BACKGROUND_CONTEXT),
									}),
						},
						context,
					),
				),
				(opened) => Effect.orDie(call((context) => opened.close(context))),
			);
			hostSeams.set(harness, seams);
			if (options.readOnly !== true && options.resume !== false) yield* Effect.sync(() => harness.resume());
			return harness;
		}),
	);
}

/** What `layer` keeps beside a harness it opened: where Pi's host callbacks hand their values on. */
interface Seams {
	readonly reports: PubSub.PubSub<Report>;
	readonly wakes: Queue.Queue<Wake, Cause.Done>;
}

// Keyed by the harness and held weakly: the service value stays Pi's own object, and a closed harness frees its seams.
const hostSeams = new WeakMap<Open, Seams>();

/** What a new conversation is owned by, runs with, and gets in the commit that creates it. */
export interface CreateOptions<E = never, R = never> {
	readonly ownership: ConversationOwnership;
	/** Applied in the creating commit; tools and extensions as values or as names. */
	readonly agent?: Agent.Change;
	/** Runs in the creating commit, after `conversationCreated` and the `agent` change: see `Conversation.Init`. */
	readonly init?: Init.Init<E, R>;
}

/** The root conversation, created empty on first use. */
export const root: Effect.Effect<Conversation.Conversation, DurableError, Harness> = rootWith({});

/**
 * The root conversation, created with `agent` and `init` in one commit on first use; an existing root ignores both.
 * It fails with `init`'s own failure when that failed, and no root is stored then.
 */
export function rootWith<E = never, R = never>(options: {
	readonly agent?: Agent.Change;
	readonly init?: Init.Init<E, R>;
}): Effect.Effect<Conversation.Conversation, E | DurableError, Harness | R> {
	const agent = options.agent === undefined ? {} : { agent: Agent.toPi(options.agent) };
	return Effect.map(
		Harness.use((harness) =>
			Init.creating(options.init, (init, context) => harness.root(context, { ...agent, ...init })),
		),
		Conversation.fromPi,
	);
}

/** The conversation with this id, if it exists. */
export function conversation(
	id: ConversationId,
): Effect.Effect<Option.Option<Conversation.Conversation>, DurableError, Harness> {
	return Effect.map(
		use((harness, context) => harness.conversation(id, context)),
		(found) => Option.map(Option.fromNullishOr(found), Conversation.fromPi),
	);
}

/**
 * A new conversation, created in one commit. It fails with `init`'s own failure when that failed, and nothing is
 * stored then.
 */
export function createConversation<E = never, R = never>(
	options: CreateOptions<E, R>,
): Effect.Effect<Conversation.Conversation, E | DurableError, Harness | R> {
	return Effect.map(
		Harness.use((harness) =>
			Init.creating(options.init, (init, context) =>
				harness.createConversation({ ...Agent.creation(options), ...init }, context),
			),
		),
		Conversation.fromPi,
	);
}

/**
 * One atomic commit whose body is an Effect on its transaction (see `Tx`): the body's value once the commit is stored,
 * the body's own failure, with nothing stored, when it fails. The body's services come from the caller.
 */
export function commit<A, E, R>(
	change: (tx: Tx.Tx) => Effect.Effect<A, E, R>,
	options?: CommitOptions,
): Effect.Effect<A, E | DurableError, R | Harness> {
	return Harness.use((harness) =>
		Tx.commit((body, context, given) => harness.commit(body, context, given), change, options),
	);
}

/** The committed value of a document, decoded; none while it does not exist. It never creates one. */
export function snapshot<D extends Doc.Any>(
	doc: D,
	...address: Doc.Address<D>
): Effect.Effect<Option.Option<Doc.Value<D>>, Doc.Failure, Harness> {
	return Harness.use((harness) => Doc.reader(harness).snapshot(doc, ...address));
}

/** The value a rewindable conversation document had when the entry `at` was committed; none when it did not exist. */
export function snapshotAsOf<D extends Doc.Rewindable>(
	doc: D,
	...address: [...Doc.Address<D>, at: EntryId]
): Effect.Effect<Option.Option<Doc.Value<D>>, Doc.Failure, Harness> {
	return Harness.use((harness) => Doc.reader(harness).snapshotAsOf(doc, ...address));
}

/**
 * Pi's `watchDoc` as a Stream: the document's value now, then one element per change, decoded, with its Chord
 * operations (see `Watch.stream`). It follows the address: a retirement is an element with `retired`, and a document
 * created there later arrives on the same stream. No element at all when the address holds no document now. Closing
 * the stream's scope releases the watch.
 */
export function watchDoc<D extends Doc.Any>(
	doc: D,
	...address: Doc.Address<D>
): Stream.Stream<Watch.Change<Doc.Value<D>>, Doc.Failure, Harness> {
	return Stream.unwrap(Harness.use((harness) => Effect.succeed(Doc.watch(harness, doc, ...address))));
}

/**
 * Pi's `watchTaskGraph` as a Stream: every live task with its owner, status and owned conversations, now and at each
 * change. Closing the stream's scope releases the watch.
 */
export const taskGraph: Stream.Stream<Watch.Change<TaskGraph>, DurableError, Harness> = Stream.unwrap(
	Harness.use((harness) => Effect.succeed(Watch.stream((context) => harness.watchTaskGraph(context)))),
);

/**
 * Pi's `observeCommits` as a Stream: one element per stored commit from the moment the stream runs, in commit order,
 * each with its `seq` and exactly the changes that storage transaction stored (see `Watch.commits`). Elements wait in
 * memory until taken, without a bound: a slow consumer never holds a commit up. It fails with `UnexpectedError`
 * ("session closed") when the harness closes. Closing the stream's scope detaches the observer.
 */
export const commits: Stream.Stream<Watch.Commit, DurableError, Harness> = Stream.unwrap(
	Harness.use((harness) => Effect.succeed(Watch.commits((observer) => harness.observeCommits(observer)))),
);

/**
 * The stored conversations `query` selects, in id order: all of them, or those a task or the tasks of a conversation
 * own. Read page by page as the stream is pulled, each page in a commit of its own that writes nothing (see
 * `Scans.conversations`): a caller needs no read-only commit.
 */
export function scanConversations(
	query?: Scans.ConversationsQuery,
): Stream.Stream<ConversationRecord, DurableError, Harness> {
	return Stream.unwrap(Harness.use((harness) => Effect.succeed(Scans.conversations(reading(harness), query))));
}

/**
 * The stored tasks `query` selects, in id order, ended ones included: by conversation, kind, status, abort mark or
 * background flag. Read as `scanConversations` reads (see `Scans.tasks`).
 */
export function scanTasks(
	query?: Scans.TasksQuery,
): Stream.Stream<TaskRecord<JsonValue, JsonValue, JsonValue>, DurableError, Harness> {
	return Stream.unwrap(Harness.use((harness) => Effect.succeed(Scans.tasks(reading(harness), query))));
}

/**
 * A conversation's stored record, if it exists: its id, where it was forked from (`parent`) and the task that owns it
 * (`owner`). Pi stores nothing else of a conversation's creation. Read in a commit that writes nothing.
 */
export function conversationRecord(
	id: ConversationId,
): Effect.Effect<Option.Option<ConversationRecord>, DurableError, Harness> {
	return Effect.map(
		use((harness, context) => harness.commit((tx) => tx.conversation(id), context)),
		Option.fromUndefinedOr,
	);
}

/**
 * Every report of Pi from the moment the stream runs: failures that fail no call, such as a throwing hook
 * (`extension_error`), a faulted task, a failing host callback, and the error that failed the harness
 * (`storage_failed`). The whole report, its error included. Each subscriber gets every report; one that runs later
 * misses the earlier ones. `layer` also logs each report, at `Error` or `Warn`, with its kind, ids and names and
 * never the error's message. It ends when the harness closes, and has no element for a harness `layer` did not open.
 */
export const reports: Stream.Stream<Report, never, Harness> = fromSeams(({ reports }) => Stream.fromPubSub(reports));

/**
 * With the option `hostWakes`: every value Pi gives its `onWake`, in order, kept until taken. One element after open
 * and one whenever `wake` changes: `active` while some task can run now or is running, `at` for the earliest sleep not
 * yet due. One consumer: two would share the elements. Pi calls `onWake` after the commit that changed the value, so a
 * host arms a recovery wake-up before a call that can start work (`submit`, `signal`, `compact`, an abort). It ends
 * when the harness closes; without the option it has no element.
 */
export const wakes: Stream.Stream<Wake, never, Harness> = fromSeams(({ wakes }) => Stream.fromQueue(wakes));

/** When the harness next needs a running process, from the scheduler's memory (Pi's `wake()`); also while paused. */
export const wake: Effect.Effect<Wake, never, Harness> = Harness.useSync((harness) => harness.wake());

/**
 * Enables task scheduling (Pi's `resume()`): what a host runs when its own wake-up fires, so due sleeps and work a
 * lost process left continue. Idempotent. Fails with `ReadOnlySession` on a read-only harness.
 */
export const resume: Effect.Effect<void, DurableError, Harness> = Harness.use((harness) =>
	Effect.try({ try: () => harness.resume(), catch: fromRejection }),
);

/**
 * One conversation's usage ledger (Pi's `pi.usage` document), observed commit by commit: first its value now, then
 * one element for every commit that changed it, in order and unfolded, however slow the consumer is. `value` is the
 * conversation's totals after that commit, per `provider/model` under `models` and per tool name under `tools`;
 * `ops` are the commit's changes, whose paths name the bucket and the key. Pi adds to the ledger in the commit that
 * records a model response, an error or an aborted one included, a tool result that reports usage, or a compaction's
 * summarization attempt, so each of those is one element. A fork's ledger starts at zero. It fails with
 * `UnexpectedError` ("session closed") when the harness closes, as Pi ends its observers.
 */
export function usageEvents(
	conversationId: ConversationId,
): Stream.Stream<Watch.Change<Readonly<UsageState>>, DurableError, Harness> {
	return Stream.unwrap(
		Harness.use((harness) =>
			Effect.succeed(
				Watch.observed<Readonly<UsageState>>((observer, context) =>
					harness.observeDoc(UsageDoc, conversationId, observer, context),
				),
			),
		),
	);
}

/** Succeeds once no ownerless conversation has live work. Interrupting it cancels only this wait. */
export const waitForIdle: Effect.Effect<void, DurableError, Harness> = use((harness, context) =>
	harness.waitForIdle(context),
);

/** Live tasks and unsettled submissions at one point; writes nothing and runs nothing. */
export const inspect: Effect.Effect<HarnessInspection, DurableError, Harness> = use((harness, context) =>
	harness.inspect(context),
);

/**
 * Whether `waitForIdle` would succeed at once: no ownerless conversation has live work now. It never waits and starts
 * no scheduling. Pi has no such call: this applies Pi's idle rule to the live tasks of `inspect` (see `Idle.quiet`),
 * and reads their owners in a commit that writes nothing when any task is live.
 */
export const isIdle: Effect.Effect<boolean, DurableError, Harness> = idle({ kind: "harness" });

/**
 * Whether a conversation's `waitForIdle` would succeed at once: neither it nor a conversation its tasks own has live
 * work that is not in the background. Otherwise as `isIdle`. Not what admission asks: a conversation is busy for
 * `submit` while a run is going on, which is `run` of its `pi.live` document (`BuiltinDoc.live`).
 */
export function isConversationIdle(id: ConversationId): Effect.Effect<boolean, DurableError, Harness> {
	return idle({ kind: "conversation", conversationId: id });
}

/** Tokens and cost of every conversation, summed per model and per tool. */
export const usage: Effect.Effect<UsageState, DurableError, Harness> = use((harness, context) =>
	harness.usage(context),
);

/** The submission with this id, if it exists: for example to wait for it after a reopen. */
export function submission(
	id: SubmissionId,
): Effect.Effect<Option.Option<Submission.Submission>, DurableError, Harness> {
	return Effect.map(
		use((harness, context) => harness.submission(id, context)),
		(found) => Option.map(Option.fromNullishOr(found), Submission.fromPi),
	);
}

/** What Pi did with an abort of a submission: `aborted`, or what it found instead. */
export type AbortSubmissionResult = Awaited<ReturnType<PiHarness["abortSubmission"]>>;

/** Withdraws a queued submission; `not_found` for an unknown one, or one of another conversation than `conversationId`. */
export function abortSubmission(
	id: SubmissionId,
	conversationId?: ConversationId,
): Effect.Effect<AbortSubmissionResult, DurableError, Harness> {
	return use((harness, context) => harness.abortSubmission(id, context, conversationId));
}

/** The stored record of a task, if it exists: its state, memos and outcome. */
export function getTask<R>(
	id: TaskId<R>,
): Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, R>>, DurableError, Harness> {
	return Effect.map(
		use((harness, context) => harness.getTask(id, context)),
		Option.fromNullishOr,
	);
}

/** Succeeds with the task's terminal record once it ended. Interrupting it cancels only this wait. */
export function waitForTask<R>(id: TaskId<R>): Effect.Effect<SettledTask<R>, DurableError, Harness> {
	return use((harness, context) => harness.waitForTask(id, context));
}

/** `getTask` of a task of `task`'s kind: the result of an outcome it holds is decoded with the task's schema. */
export function getTaskOf<A>(
	task: Task.Kind<never, A>,
	id: TaskId,
): Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, A>>, DurableError | SchemaDecodeError, Harness> {
	return Effect.flatMap(
		getTask(id),
		Option.match({
			onNone: () => Effect.succeedNone,
			onSome: (stored) => Effect.asSome(Task.record(task, stored)),
		}),
	);
}

/** `waitForTask` of a task of `task`'s kind: the result of its outcome is decoded with the task's schema. */
export function waitForTaskOf<A>(
	task: Task.Kind<never, A>,
	id: TaskId,
): Effect.Effect<Task.Settled<A>, DurableError | SchemaDecodeError, Harness> {
	return Effect.flatMap(waitForTask(id), (stored) => Task.settled(task, stored));
}

/** What Pi did with an abort of a task: `marked`, or `terminal` when it had ended already. */
export type AbortTaskResult = Awaited<ReturnType<PiHarness["abortTask"]>>;

/** Marks a task aborted and lets its abort handler run; `terminal` when it had ended already. */
export function abortTask(id: TaskId): Effect.Effect<AbortTaskResult, DurableError, Harness> {
	return use((harness, context) => harness.abortTask(id, context));
}

/**
 * Delivers `value` to the task `taskId` under `key`, in a commit of its own, and says what Pi did with it:
 * `delivered`, `duplicate`, `invalid`, `closed` or `not_found`. A value outside the signal's schema fails with
 * `SchemaDecodeError` before Pi is called, so nothing is stored. Nothing checks who sends: authenticate in the host.
 */
export function signal<S extends Schema.Constraint>(
	taskId: TaskId,
	kind: Signal.Signal<S>,
	key: string,
	value: S["Type"],
): Effect.Effect<SignalResult, DurableError | Signal.Failure, Harness | S["EncodingServices"]> {
	return Effect.gen(function* () {
		const token = yield* kind.token;
		const json = yield* kind.encode(value);
		return yield* use((harness, context) => harness.signal(taskId, token, key, json, context));
	});
}

/**
 * The state of `key` of `kind` in the task `taskId`, read from outside the task: none while nothing came, when there
 * is no such task, and once the task ended, since Pi drops a task's memos with its outcome. Pi has no call for it:
 * this reads the memo Pi keeps the state in (see `Signal.stateIn`), a convention of Pi's stored data.
 */
export function signalState<S extends Schema.Constraint>(
	taskId: TaskId,
	kind: Signal.Signal<S>,
	key: string,
): Effect.Effect<
	Option.Option<Signal.State<S["Type"]>>,
	DurableError | Signal.Failure,
	Harness | S["DecodingServices"]
> {
	return Effect.flatMap(
		getTask(taskId),
		Option.match({
			onNone: () => Effect.succeedNone,
			onSome: (record) => Signal.stateIn(record, kind, key),
		}),
	);
}

/** Whether `scope` is idle now. A harness without live tasks is: nothing is read then. */
function idle(scope: Idle.Scope): Effect.Effect<boolean, DurableError, Harness> {
	return Effect.flatMap(inspect, ({ tasks }) => {
		const live = tasks.map((task) => task.record);
		return live.length === 0 ? Effect.succeed(true) : commit((tx) => Idle.quiet(live, scope, tx));
	});
}

/** Pi's table reads of a harness, each in a commit of its own that writes nothing. */
function reading(harness: PiHarness): Scans.Read {
	return (read) => call((context) => harness.commit(read, context));
}

/** A stream of what `layer` keeps beside the harness of the context; none of it for a harness opened otherwise. */
function fromSeams<A>(read: (seams: Seams) => Stream.Stream<A>): Stream.Stream<A, never, Harness> {
	return Stream.unwrap(
		Harness.use((harness) =>
			Effect.succeed(
				Option.match(Option.fromUndefinedOr(hostSeams.get(harness)), { onNone: () => Stream.empty, onSome: read }),
			),
		),
	);
}

/** One call on the harness of the context. */
function use<A>(
	run: (harness: PiHarness, context: ChordContext) => Promise<A>,
): Effect.Effect<A, DurableError, Harness> {
	return Harness.use((harness) => call((context) => run(harness, context)));
}
