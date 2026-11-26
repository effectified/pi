// Commits in Effect: Pi Durable's transaction as a value of Effects, and a commit whose body is an Effect.

import {
	type CommitOptions,
	type ConversationHandle,
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	configure,
	type EntryDraft,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Page,
	type Tx as PiTx,
	type SignalResult,
	type SubmissionDraft,
	type SubmissionId,
	type SubmissionRecord,
	type TaskId,
	type TaskOptions,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import type { JsonValue } from "@effectified/pi-chord/json";
import type { SchemaDecodeError } from "@effectified/pi-schema";
import { type Cause, Effect, Exit, Option, type Schema, type Stream } from "effect";
import * as Agent from "./agent.ts";
import { call, step } from "./call.ts";
import * as Doc from "./doc.ts";
import * as Entry from "./entry.ts";
import type { DurableError } from "./errors.ts";
import * as Scans from "./scans.ts";
import type * as Signal from "./signal.ts";
import type * as Task from "./task.ts";

/**
 * The transaction of one commit: what its body reads and writes, stored together or not at all. Pi's rules hold:
 *
 * - **Table reads come first.** Tables are conversations, entries, tasks and submissions. After the commit's first
 *   table write (`appendEntry`, `append`, `createConversation`, `forkConversation`, a task or a submission through
 *   `pi`), every table read fails with `ReadAfterWrite`, and so do `signal` and an admission (`Conversation.admit`),
 *   which read. Creations return what they created, so nothing needs reading back.
 * - **Documents any time.** `doc` and `retireDoc` work before and after table writes, and a document reads its own
 *   writes.
 * - **Only through the transaction.** The body runs on the harness's one line of commits and holds it: a read of the
 *   harness, a conversation or a submission made inside the body waits for that line and never returns.
 * - **No long work.** No model call, no network, no sleep: every other commit of the harness waits for the body.
 * - **Nothing leaves.** Every operation fails once the body ended.
 */
export interface Tx {
	/** A conversation's record; a table read. */
	readonly conversation: (id: ConversationId) => Effect.Effect<Option.Option<ConversationRecord>, DurableError>;
	/** An entry, whichever conversation it is in; a table read. */
	readonly entry: (id: EntryId) => Effect.Effect<Option.Option<EntryRecord>, DurableError>;
	/** An entry as one of `entry`'s kind, its data decoded: none when it is absent or has another kind; a table read. */
	readonly entryOf: <S extends Schema.Constraint>(
		entry: Entry.Entry<S>,
		id: EntryId,
	) => Effect.Effect<Option.Option<Entry.Typed<S["Type"]>>, DurableError | SchemaDecodeError, S["DecodingServices"]>;
	/** A task's record; a table read. */
	readonly task: (
		id: TaskId,
	) => Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, JsonValue>>, DurableError>;
	/** One page of conversations, for example those a task owns (`ownerTaskId`); a table read. */
	readonly scanConversations: (
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	) => Effect.Effect<Page<ConversationRecord, Cursor>, DurableError>;
	/** One page of a conversation's fork-aware history; a table read. */
	readonly scanEntries: (
		query: EntryQuery,
		limit: number,
		cursor?: Cursor,
	) => Effect.Effect<Page<EntryRecord, Cursor>, DurableError>;
	/**
	 * One page of stored tasks, in id order, ended ones included: by conversation, kind, status, abort mark or
	 * background flag (Pi's `TaskQuery`); a table read.
	 */
	readonly scanTasks: (
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	) => Effect.Effect<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>, DurableError>;
	/**
	 * Every conversation `query` selects, in id order: `scanConversations` page by page as the stream is pulled, every
	 * page in this commit, so the stream is one point in time. A table read for each page.
	 */
	readonly conversations: (query?: Scans.ConversationsQuery) => Stream.Stream<ConversationRecord, DurableError>;
	/** Every task `query` selects, in id order, ended ones included: `scanTasks` read as `conversations` reads. */
	readonly tasks: (
		query?: Scans.TasksQuery,
	) => Stream.Stream<TaskRecord<JsonValue, JsonValue, JsonValue>, DurableError>;
	/** The id of the newest entry visible from the conversation: where a fork of this commit starts; a table read. */
	readonly latestEntryId: (conversationId: ConversationId) => Effect.Effect<Option.Option<EntryId>, DurableError>;
	/** A submission's record; a table read. */
	readonly submission: (id: SubmissionId) => Effect.Effect<Option.Option<SubmissionRecord>, DurableError>;
	/** The submission a conversation admitted under `requestId`; a table read. */
	readonly submissionByRequest: (
		conversationId: ConversationId,
		requestId: string,
	) => Effect.Effect<Option.Option<SubmissionRecord>, DurableError>;

	/**
	 * A new conversation; a table write. A task-owned one starts as a copy of its owner's conversation's agent. It gives
	 * the record, never a handle: use `Harness.conversation` or a tool's `api.conversation` after the commit.
	 */
	readonly createConversation: (
		options: Parameters<PiTx["createConversation"]>[0],
	) => Effect.Effect<ConversationRecord, DurableError>;
	/** A fork of `parent` that sees its entries up to `at`; a table write. */
	readonly forkConversation: (
		parent: ConversationId,
		at: EntryId,
		options: Parameters<PiTx["forkConversation"]>[2],
	) => Effect.Effect<ConversationRecord, DurableError>;
	/** Appends an entry as it is; a table write. Model messages in `model` join the model's context. */
	readonly appendEntry: (
		conversationId: ConversationId,
		draft: EntryDraft,
	) => Effect.Effect<EntryRecord, DurableError>;
	/** Appends an entry of `entry`'s kind, its data encoded; a table write. */
	readonly append: <S extends Schema.Constraint>(
		entry: Entry.Entry<S>,
		conversationId: ConversationId,
		draft: Entry.Draft<S["Type"]>,
	) => Effect.Effect<Entry.Typed<S["Type"]>, DurableError | SchemaDecodeError, S["EncodingServices"]>;
	/**
	 * Changes what a conversation runs with (Pi's `configure(tx, …)`): a document write, so it works after table
	 * writes, also on a conversation this commit created.
	 */
	readonly configure: (conversationId: ConversationId, change: Agent.Change) => Effect.Effect<void, DurableError>;
	/**
	 * Delivers `value` to the task `taskId` under `key`, with this commit. It reads the task, so it comes before the
	 * first table write. The result is provisional until the commit is stored. Nothing checks who sends.
	 */
	readonly signal: <S extends Schema.Constraint>(
		taskId: TaskId,
		signal: Signal.Signal<S>,
		key: string,
		value: S["Type"],
	) => Effect.Effect<SignalResult, DurableError | Signal.Failure, S["EncodingServices"]>;
	/**
	 * Opens a document for reading and writing, creating it from its definition when it does not exist. For a family,
	 * the last argument is the seed a missing member is created from.
	 */
	readonly doc: <D extends Doc.Any>(
		doc: D,
		...opening: Doc.Opening<D>
	) => Effect.Effect<Doc.Open<Doc.Value<D>>, DurableError>;
	/** Retires the document at this address, if it exists; opening it again in this commit creates a new one. */
	readonly retireDoc: <D extends Doc.Any>(doc: D, ...address: Doc.Address<D>) => Effect.Effect<void, DurableError>;
	/**
	 * A new task of `task`'s kind with `input`, encoded, and its id; a table write. `options` are Pi's: `ownership` is
	 * required (`{ kind: "conversation" }` for a top-level task, `{ kind: "task", taskId }` for a child, which lives in
	 * its owner's conversation and must have a live owner), `conversationId` defaults to the conversation the commit is
	 * bound to (a conversation's, a tool call's, a task's) and is required in a harness commit, and `background` keeps a
	 * conversation-owned task out of idle waits and aborts. It runs once the commit is stored and scheduling is on, under
	 * the definition a registry holds for its name. A commit has no key for exactly-once creation: a tool's
	 * `api.createTask` has one.
	 */
	readonly createTask: <I, A>(
		task: Task.Kind<I, A>,
		input: NoInfer<I>,
		options: TaskOptions,
	) => Effect.Effect<TaskId, DurableError | SchemaDecodeError>;
	/** Pi's own transaction, for what this package does not wrap: raw submissions, `latestHeadMarker`. */
	readonly pi: PiTx;
}

/** The Effect form of Pi's transaction. */
export function fromPi(tx: PiTx): Tx {
	const found = <A>(read: () => Promise<A | undefined>) => Effect.map(step(read), Option.fromUndefinedOr);
	const entry = (id: EntryId) => found(() => tx.entry(id));
	const read: Scans.Read = (scan) => step(() => scan(tx));
	return {
		conversation: (id) => found(() => tx.conversation(id)),
		entry,
		entryOf: (kind, id) => Entry.typed(kind, entry(id)),
		task: (id) => found(() => tx.task(id)),
		scanConversations: (query, limit, cursor) => step(() => tx.scanConversations(query, limit, cursor)),
		scanEntries: (query, limit, cursor) => step(() => tx.scanEntries(query, limit, cursor)),
		scanTasks: (query, limit, cursor) => step(() => tx.scanTasks(query, limit, cursor)),
		conversations: (query) => Scans.conversations(read, query),
		tasks: (query) => Scans.tasks(read, query),
		latestEntryId: (conversationId) => found(() => tx.latestEntryId(conversationId)),
		submission: (id) => found(() => tx.submission(id)),
		submissionByRequest: (conversationId, requestId) =>
			found(() => tx.submissionByRequest(conversationId, requestId)),
		createConversation: (options) => step(() => tx.createConversation(options)),
		forkConversation: (parent, at, options) => step(() => tx.forkConversation(parent, at, options)),
		appendEntry: (conversationId, draft) => step(() => tx.appendEntry(conversationId, draft)),
		append: (kind, conversationId, draft) =>
			Effect.flatMap(kind.draft(draft), (encoded) =>
				Effect.map(
					step(() => tx.appendEntry(kind.token, conversationId, encoded)),
					// The record Pi returns is the draft with its ids: its data is the value just encoded.
					(record) => ({ ...record, data: draft.data }),
				),
			),
		configure: (conversationId, change) => step(() => configure(tx, conversationId, Agent.toPi(change))),
		signal: (taskId, kind, key, value) =>
			Effect.gen(function* () {
				const token = yield* kind.token;
				const json = yield* kind.encode(value);
				return yield* step(() => tx.signal(taskId, token, key, json));
			}),
		doc: (doc, ...opening) => Doc.open(tx, doc, ...opening),
		retireDoc: (doc, ...address) => Doc.retire(tx, doc, ...address),
		createTask: (task, input, options) =>
			Effect.flatMap(task.encodeInput(input), (json) => step(() => tx.createTask(task.token, json, options))),
		pi: tx,
	};
}

/**
 * Admits a submission inside the commit of `tx`, with the rules of `submit`, and gives its id: it is stored with that
 * commit or not at all. It comes before the commit's first table write, another admission included; later it fails
 * with `ReadAfterWrite`. A refusal (`ConversationBusy`, `ConversationIdle`) fails before any write, so the body may
 * catch it and go on. `target` is Pi's conversation or conversation handle.
 */
export function admit(
	target: Pick<ConversationHandle, "admit">,
	tx: Tx,
	draft: SubmissionDraft,
): Effect.Effect<SubmissionId, DurableError> {
	return step(() => target.admit(tx.pi, draft));
}

/** Pi's commit of a harness, a conversation or a tool call: the callback gets the transaction. */
export type PiCommit = <A>(
	change: (tx: PiTx) => Promise<A>,
	context: ChordContext,
	options?: CommitOptions,
) => Promise<A>;

/**
 * One commit whose body is an Effect. The body runs with the caller's services, inside Pi's commit.
 *
 * - The body succeeds: Pi stores everything it wrote in one atomic commit, and the Effect succeeds with its value once
 *   the commit is stored and published.
 * - The body fails, with a failure or a defect: Pi rolls the commit back, nothing is stored, and the Effect fails with
 *   the body's own cause, so a typed failure `E` stays `E`.
 * - The caller is interrupted while the body runs: the body is interrupted, which fails it, so nothing is stored. Once
 *   the body has ended, the commit is admitted and Pi stores it whatever happens to the caller; the interruption then
 *   completes when Pi settled the commit.
 *
 * `options` are Pi's: `persistence` may defer storing a commit that only changes existing conversation documents with
 * `history: "latest"` and `fork: "initial"`. `parent` as for `call`.
 */
export function commit<A, E, R>(
	run: PiCommit,
	change: (tx: Tx) => Effect.Effect<A, E, R>,
	options?: CommitOptions,
	parent?: ChordContext,
): Effect.Effect<A, E | DurableError, R> {
	return during((inside, context) => run((tx) => inside(tx, change), context, options), parent);
}

/** Runs an Effect on Pi's transaction as the promise a callback of Pi returns from inside a commit. */
export type Inside<E, R> = <A>(tx: PiTx, body: (tx: Tx) => Effect.Effect<A, E, R>) => Promise<A>;

/**
 * One Pi call whose callback runs inside a commit, such as `commit` or a creation with `init`: `enter` makes the call
 * and hands `inside` the transaction and the Effect each time Pi calls back. The body runs with the caller's services
 * and is interrupted with the caller. When a body fails, Pi rejects the call and stores nothing, and the Effect fails
 * with the body's own cause; any other rejection is its `DurableError`. `parent` as for `call`.
 */
export function during<A, E, R>(
	enter: (inside: Inside<E, R>, context: ChordContext) => Promise<A>,
	parent?: ChordContext,
): Effect.Effect<A, E | DurableError, R> {
	return Effect.flatMap(Effect.context<R>(), (services) => {
		const runBody = Effect.runPromiseExitWith(services);
		// Set when a body failed: Pi then rejects the call, and this cause is why.
		let failed: Cause.Cause<E> | undefined;
		const insideOf =
			(signal: AbortSignal | undefined): Inside<E, R> =>
			(tx, body) =>
				runBody(
					Effect.suspend(() => body(fromPi(tx))),
					{ signal },
				).then((exit) => {
					if (Exit.isSuccess(exit)) return exit.value;
					failed = exit.cause;
					// A rejected callback is how Pi learns that the commit must be rolled back.
					return Promise.reject(exit.cause);
				});
		return Effect.catch(
			call((context) => enter(insideOf(context.abortSignal), context), parent),
			(error): Effect.Effect<never, E | DurableError> =>
				failed === undefined ? Effect.fail(error) : Effect.failCause(failed),
		);
	});
}
