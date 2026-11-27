// A thread as it is stored: the document that finds its conversation by the product's key, and its submissions.

import type { ConversationId, SubmissionRecord } from "@effectified/pi-durable";
import { Conversation, Doc, Harness, type Tx } from "@effectified/pi-durable";
import * as Swarm from "@effectified/pi-swarm";
import { Array as Arr, Effect, Option, Schema } from "effect";
import { ThreadNotFound } from "./errors.ts";
import { RequestKey, type ThreadKey } from "./ids.ts";

/**
 * One document per thread key, kind `thread.work`, in the session scope:
 *
 * - `conversation`: the conversation the thread runs in. Pi has no index of conversations by a product's key, so it
 *   is kept here, written in the commit that creates the conversation: the key and the conversation exist together
 *   or not at all.
 * - `requests`: the request keys the thread's work was admitted under, oldest first: its task, then every
 *   continuation of a run that ended without an answer. Each is the request id of one submission, which is what
 *   makes an admission idempotent by its key. A key is written before its submission is admitted, so the newest
 *   one may have none yet.
 * - `swarms`: the ids of the swarms started on the thread, oldest first: what a thread's money is added up over when
 *   its swarms' forks live in other storages. An id is written before its swarm is stored, so the newest one may
 *   name no swarm yet.
 */
export const Document = Doc.family({
	kind: "thread.work",
	version: 1,
	scope: "session",
	schema: Schema.Struct({
		conversation: Schema.NullOr(Conversation.Id),
		requests: Schema.Array(RequestKey),
		swarms: Schema.Array(Swarm.SwarmId),
	}),
	initial: (_seed: null) => ({ conversation: null, requests: [], swarms: [] }),
	// Three small fields: every change is stored whole.
	checkpointWhen: () => true,
});

/** The conversation of the thread stored under `thread`; fails with `ThreadNotFound` for a key nothing started. */
export const find = Effect.fn("Thread.find")(function* (
	thread: ThreadKey,
): Effect.fn.Return<ConversationId, ThreadNotFound | Doc.Failure, Harness.Harness> {
	const stored = yield* Harness.snapshot(Document, thread);
	const conversation = Option.flatMapNullishOr(stored, (held) => held.conversation);
	return yield* Effect.fromOption(conversation, () => ThreadNotFound.make({ thread }));
});

/** The conversation of the thread stored under `thread`, as a handle; fails with `ThreadNotFound` as `find` does. */
export const conversation = Effect.fn("Thread.conversation")(function* (
	thread: ThreadKey,
): Effect.fn.Return<Conversation.Conversation, ThreadNotFound | Doc.Failure, Harness.Harness> {
	const id = yield* find(thread);
	return yield* handleOf(id);
});

/** The conversation `id`, which a thread's document names: a harness without it has lost its own storage. */
export const handleOf = Effect.fn("Thread.handleOf")(function* (
	id: ConversationId,
): Effect.fn.Return<Conversation.Conversation, Doc.Failure, Harness.Harness> {
	const found = yield* Harness.conversation(id);
	if (Option.isNone(found))
		return yield* Effect.die(new Error(`Conversation ${id} of a stored thread does not exist`));
	return found.value;
});

/**
 * The request key a thread's submission number `attempt` gets when its caller names none: 0 is its task, 1 and up
 * are the continuations of runs that ended without an answer. Fixed by the thread's key, so a retried call finds the
 * submission it admitted.
 */
export function requestId(thread: ThreadKey, attempt: number): RequestKey {
	return RequestKey.make(`${thread}#${attempt}`);
}

/**
 * The newest submission of a thread, its number, and the request key it was admitted under. An interface, not a
 * Schema: it carries Pi's record of the submission as Pi gives it.
 */
export interface Newest {
	readonly attempt: number;
	readonly key: RequestKey;
	readonly record: SubmissionRecord;
}

/**
 * The newest submission the thread's conversation admitted, read inside a commit; none before its task was admitted.
 * The thread's request keys are read newest first until one has a submission. Table reads: they come before the
 * commit's first table write.
 */
export const newestIn = Effect.fn("Thread.newestIn")(function* (
	tx: Tx.Tx,
	conversation: ConversationId,
	thread: ThreadKey,
): Effect.fn.Return<Option.Option<Newest>, Doc.Failure> {
	const document = yield* tx.doc(Document, thread, null);
	const { requests } = yield* document.get;
	for (let attempt = requests.length - 1; attempt >= 0; attempt -= 1) {
		const key = requests[attempt];
		const record = yield* tx.submissionByRequest(conversation, key);
		if (Option.isSome(record)) return Option.some({ attempt, key, record: record.value });
	}
	return Option.none();
});

/** `newestIn`, in a commit of its own that only reads. */
export const newest = Effect.fn("Thread.newest")(function* (
	conversation: ConversationId,
	thread: ThreadKey,
): Effect.fn.Return<Option.Option<Newest>, Doc.Failure, Harness.Harness> {
	return yield* Harness.commit((tx) => newestIn(tx, conversation, thread));
});

/**
 * Every submission the thread's conversation admitted, oldest first, each as `newest` gives one: its task, then each
 * continuation. A request key without a submission yet is left out. One commit that only reads.
 */
export const submissions = Effect.fn("Thread.submissions")(function* (
	conversation: ConversationId,
	thread: ThreadKey,
): Effect.fn.Return<ReadonlyArray<Newest>, Doc.Failure, Harness.Harness> {
	return yield* Harness.commit(
		Effect.fnUntraced(function* (tx) {
			const document = yield* tx.doc(Document, thread, null);
			const { requests } = yield* document.get;
			// One read after the other: a commit's reads go through its one transaction.
			const found = yield* Effect.forEach(
				requests,
				(key, attempt) =>
					Effect.map(
						tx.submissionByRequest(conversation, key),
						Option.map((record): Newest => ({ attempt, key, record })),
					),
				{ concurrency: 1 },
			);
			return Arr.getSomes(found);
		}),
	);
});

/**
 * Notes `key` as the thread's newest request key, inside the caller's commit, unless the thread holds it already. It
 * gives the request keys the thread then has.
 */
export const noteRequestIn = Effect.fn("Thread.noteRequestIn")(function* (
	tx: Tx.Tx,
	thread: ThreadKey,
	key: RequestKey,
): Effect.fn.Return<ReadonlyArray<RequestKey>, Doc.Failure> {
	const document = yield* tx.doc(Document, thread, null);
	const held = yield* document.get;
	if (Arr.contains(held.requests, key)) return held.requests;
	const requests = Arr.append(held.requests, key);
	yield* document.set({ ...held, requests });
	return requests;
});

/** `noteRequestIn`, in a commit of its own. */
export const noteRequest = Effect.fn("Thread.noteRequest")(function* (
	thread: ThreadKey,
	key: RequestKey,
): Effect.fn.Return<ReadonlyArray<RequestKey>, Doc.Failure, Harness.Harness> {
	return yield* Harness.commit((tx) => noteRequestIn(tx, thread, key));
});

/** Notes `swarmId` as a swarm started on the thread, inside the caller's commit, unless the thread holds it already. */
export const noteSwarmIn = Effect.fn("Thread.noteSwarmIn")(function* (
	tx: Tx.Tx,
	thread: ThreadKey,
	swarmId: Swarm.SwarmId,
): Effect.fn.Return<void, Doc.Failure> {
	const document = yield* tx.doc(Document, thread, null);
	const held = yield* document.get;
	if (!Arr.contains(held.swarms, swarmId)) yield* document.set({ ...held, swarms: Arr.append(held.swarms, swarmId) });
});

/** The ids of the swarms started on the thread stored under `thread`, oldest first; none for a key nothing started. */
export const swarms = Effect.fn("Thread.swarms")(function* (
	thread: ThreadKey,
): Effect.fn.Return<ReadonlyArray<Swarm.SwarmId>, Doc.Failure, Harness.Harness> {
	const stored = yield* Harness.snapshot(Document, thread);
	return Option.match(stored, { onNone: () => [], onSome: (held) => held.swarms });
});
