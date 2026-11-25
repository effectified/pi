// A thread as it is stored: the document that finds its conversation by the product's key, and its submissions.

import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import { Conversation, Doc, Harness, type Tx } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";
import { ThreadNotFound } from "./errors.ts";

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
		requests: Schema.Array(Schema.String),
		swarms: Schema.Array(Schema.String),
	}),
	initial: (_seed: null) => ({ conversation: null, requests: [], swarms: [] }),
	// Three small fields: every change is stored whole.
	checkpointWhen: () => true,
});

/** The conversation of the thread stored under `thread`; fails with `ThreadNotFound` for a key nothing started. */
export function find(thread: string): Effect.Effect<ConversationId, ThreadNotFound | Doc.Failure, Harness.Harness> {
	return Effect.flatMap(Harness.snapshot(Document, thread), (stored) =>
		Effect.mapError(
			Effect.fromNullishOr(Option.getOrUndefined(stored)?.conversation),
			() => new ThreadNotFound({ thread }),
		),
	);
}

/** The conversation of the thread stored under `thread`, as a handle; fails with `ThreadNotFound` as `find` does. */
export function conversation(
	thread: string,
): Effect.Effect<Conversation.Conversation, ThreadNotFound | Doc.Failure, Harness.Harness> {
	return Effect.flatMap(find(thread), handleOf);
}

/** The conversation `id`, which a thread's document names: a harness without it has lost its own storage. */
export function handleOf(id: ConversationId): Effect.Effect<Conversation.Conversation, Doc.Failure, Harness.Harness> {
	return Effect.flatMap(
		Harness.conversation(id),
		Option.match({
			onNone: () => Effect.die(new Error(`Conversation ${id} of a stored thread does not exist`)),
			onSome: (found) => Effect.succeed(found),
		}),
	);
}

/**
 * The request key a thread's submission number `attempt` gets when its caller names none: 0 is its task, 1 and up
 * are the continuations of runs that ended without an answer. Fixed by the thread's key, so a retried call finds the
 * submission it admitted.
 */
export function requestId(thread: string, attempt: number): string {
	return `${thread}#${attempt}`;
}

/** The newest submission of a thread, its number, and the request key it was admitted under. */
export interface Newest {
	readonly attempt: number;
	readonly key: string;
	readonly record: SubmissionRecord;
}

/**
 * The newest submission the thread's conversation admitted, read inside a commit; none before its task was admitted.
 * The thread's request keys are read newest first until one has a submission. Table reads: they come before the
 * commit's first table write.
 */
export function newestIn(
	tx: Tx.Tx,
	conversation: ConversationId,
	thread: string,
): Effect.Effect<Option.Option<Newest>, Doc.Failure> {
	return Effect.gen(function* () {
		const { requests } = yield* (yield* tx.doc(Document, thread, null)).get;
		for (let attempt = requests.length - 1; attempt >= 0; attempt -= 1) {
			const key = requests[attempt];
			const record = yield* tx.submissionByRequest(conversation, key);
			if (Option.isSome(record)) return Option.some({ attempt, key, record: record.value });
		}
		return Option.none();
	});
}

/** `newestIn`, in a commit of its own that only reads. */
export function newest(
	conversation: ConversationId,
	thread: string,
): Effect.Effect<Option.Option<Newest>, Doc.Failure, Harness.Harness> {
	return Harness.commit((tx) => newestIn(tx, conversation, thread));
}

/**
 * Notes `key` as the thread's newest request key, inside the caller's commit, unless the thread holds it already. It
 * gives the request keys the thread then has.
 */
export function noteRequestIn(
	tx: Tx.Tx,
	thread: string,
	key: string,
): Effect.Effect<ReadonlyArray<string>, Doc.Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Document, thread, null);
		const held = yield* document.get;
		if (held.requests.includes(key)) return held.requests;
		const requests = [...held.requests, key];
		yield* document.set({ ...held, requests });
		return requests;
	});
}

/** `noteRequestIn`, in a commit of its own. */
export function noteRequest(
	thread: string,
	key: string,
): Effect.Effect<ReadonlyArray<string>, Doc.Failure, Harness.Harness> {
	return Harness.commit((tx) => noteRequestIn(tx, thread, key));
}

/** Notes `swarmId` as a swarm started on the thread, inside the caller's commit, unless the thread holds it already. */
export function noteSwarmIn(tx: Tx.Tx, thread: string, swarmId: string): Effect.Effect<void, Doc.Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Document, thread, null);
		const held = yield* document.get;
		if (!held.swarms.includes(swarmId)) yield* document.set({ ...held, swarms: [...held.swarms, swarmId] });
	});
}

/** The ids of the swarms started on the thread stored under `thread`, oldest first; none for a key nothing started. */
export function swarms(thread: string): Effect.Effect<ReadonlyArray<string>, Doc.Failure, Harness.Harness> {
	return Effect.map(Harness.snapshot(Document, thread), (stored) => Option.getOrUndefined(stored)?.swarms ?? []);
}
