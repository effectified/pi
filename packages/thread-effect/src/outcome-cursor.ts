// The delivery cursor of a thread's outcome events: what was delivered last, what is being delivered, and the courier
// that delivers, with the commits that start and wake that courier.

import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { Doc, type Signal, Task, type Tx } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";
import * as Courier from "./outcome-courier.ts";
import { Mark } from "./outcome-event.ts";

/**
 * One document per thread key, kind `thread.outcomes`, in the session scope, created in the commit that creates the
 * thread:
 *
 * - `delivered`: the newest event the sink took; null before the first one. The cursor: it moves, in a commit of its
 *   own, only after the sink took the event.
 * - `pending`: the event being delivered, in its JSON form, with its mark, written before the sink is called; null
 *   when none is. An attempt that is made again, in this process or a later one, delivers this value, so a repeated
 *   event has the id and the content of the first.
 * - `courier`: the task that delivers; null when the last one ended with everything delivered.
 * - `stamp`: raised by every wake. A courier that read an older one looks again before it sleeps or ends, so a wake
 *   that comes while it works is not lost.
 * - `waiting`: the signal key the courier sleeps on; null while it does not sleep on one.
 * - `retryAt`: the time of the courier's next attempt after a failed one, in epoch milliseconds; null when none is
 *   scheduled. Until then a change of the thread does not wake the courier: the product's schedule stands.
 */
export const Document = Doc.family({
	kind: "thread.outcomes",
	version: 1,
	scope: "session",
	schema: Schema.Struct({
		delivered: Schema.NullOr(Mark),
		pending: Schema.NullOr(Schema.Struct({ mark: Mark, event: Schema.Json })),
		courier: Schema.NullOr(Task.Id),
		stamp: Schema.Number,
		waiting: Schema.NullOr(Schema.String),
		retryAt: Schema.NullOr(Schema.Number),
	}),
	initial: (_seed: null) => ({
		delivered: null,
		pending: null,
		courier: null,
		stamp: 0,
		waiting: null,
		retryAt: null,
	}),
	// Six small fields, and at most one event: every change is stored whole.
	checkpointWhen: () => true,
});

/** The cursor of one thread, as stored. */
export type Cursor = Doc.Value<typeof Document>;

/** What starting or waking a courier fails with: a failed Pi call, or a value Pi does not take. */
export type Failure = Doc.Failure | Signal.Failure;

/**
 * Starts the courier of a new thread, inside the commit that creates the thread's conversation: the thread and what
 * tells of it exist together or not at all. It reads no table, so it may follow the conversation's creation.
 */
export function openIn(tx: Tx.Tx, thread: string, conversation: ConversationId): Effect.Effect<void, Doc.Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Document, thread, null);
		const courier = yield* startIn(tx, thread, conversation);
		yield* document.set({ ...(yield* document.get), courier });
	});
}

/**
 * Makes sure that a courier looks at the thread, inside the caller's commit: a live one is woken, and one is started
 * when none is live, because the last one ended or Pi ended it. It reads a table first: call it before the commit's
 * first table write.
 */
export function wakeIn(tx: Tx.Tx, thread: string, conversation: ConversationId): Effect.Effect<void, Failure> {
	return Effect.gen(function* () {
		const document = yield* tx.doc(Document, thread, null);
		const held = yield* document.get;
		const live = held.courier === null ? Option.none<TaskId>() : yield* liveIn(tx, held.courier);
		if (Option.isNone(live)) {
			const courier = yield* startIn(tx, thread, conversation);
			return yield* document.set({ ...held, courier, stamp: held.stamp + 1, waiting: null, retryAt: null });
		}
		// Pi takes a signal only before a commit's first table write: writing the document is none.
		if (held.waiting !== null) yield* tx.signal(live.value, Courier.Nudge, held.waiting, null);
		yield* document.set({ ...held, stamp: held.stamp + 1, waiting: null });
	});
}

/** A new courier of the thread: a background task of its conversation, which holds up no idle wait and no fork. */
function startIn(tx: Tx.Tx, thread: string, conversation: ConversationId): Effect.Effect<TaskId, Doc.Failure> {
	return tx.createTask(
		Courier.task,
		{ thread },
		{ ownership: { kind: "conversation" }, conversationId: conversation, background: true },
	);
}

/** The task `id` when a signal can still reach it: none once it ended, or holds its outcome. */
function liveIn(tx: Tx.Tx, id: TaskId): Effect.Effect<Option.Option<TaskId>, Doc.Failure> {
	return Effect.map(tx.task(id), (found) =>
		Option.map(
			Option.filter(found, (record) => !Task.ended(record.state.status)),
			(record) => record.id,
		),
	);
}
