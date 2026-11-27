// The ids of this package's own: the product's key of a thread, and the request key one submission of a thread is
// admitted under. Pi's ids are Pi Durable's (`Conversation.Id`, `Submission.Id`, `Entry.Id`), a swarm's are the swarm
// plugin's (`SwarmId`, `JobKey`).

import { Schema } from "effect";

/**
 * The product's key of a thread: what finds the thread's conversation, and its idempotency key. A product brands its
 * own (`ThreadKey.make(key)`); one that crosses a host boundary or is stored is branded as it is decoded.
 */
export const ThreadKey = Schema.String.pipe(Schema.brand("@effectified/pi-thread/ThreadKey"));

/** The product's key of a thread. */
export type ThreadKey = typeof ThreadKey.Type;

/**
 * The request key of one submission of a thread, Pi's request id of that submission: its task, or a continuation of a
 * run that ended without an answer. The key the product gives (`RequestKey.make(jobKey)`), or
 * `Thread.requestId(thread, n)`. The same key is the same work.
 */
export const RequestKey = Schema.String.pipe(Schema.brand("@effectified/pi-thread/RequestKey"));

/** The request key of one submission of a thread. */
export type RequestKey = typeof RequestKey.Type;

/**
 * The id of an outcome event, made of its thread, its submission, the entry it rests on and its state
 * (`OutcomeEvent`): the same event has the same id in every delivery, so a sink keys what it stores by it.
 */
export const EventId = Schema.String.pipe(Schema.brand("@effectified/pi-thread/EventId"));

/** The id of an outcome event. */
export type EventId = typeof EventId.Type;
