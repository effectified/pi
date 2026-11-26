// The request a person decides: one ask of one tool call, with the arguments the call would run with.

import type { TaskId } from "@effectified/pi-durable";
import { Conversation, Task } from "@effectified/pi-durable";
import { Schema } from "effect";

/**
 * One ask: what a person is shown and decides. Plain JSON, the same when it is stored. Times are epoch milliseconds
 * on the harness clock.
 */
export const Request = Schema.Struct({
	/** `<task>:<n>:<digest>`, the same every time Pi asks again: what a product deduplicates by. */
	id: Schema.String,
	// Pi's ids are integers: a stored request with another number was not written by this package.
	conversation: Conversation.Id.check(Schema.isInt()),
	/** The tool call's task: where `decide` delivers the decision. */
	task: Task.Id.check(Schema.isInt()),
	/** The id the model gave the call. */
	callId: Schema.String,
	tool: Schema.String,
	/** The arguments the call would run with, as strict JSON in canonical key order. */
	arguments: Schema.JsonObject,
	/** `Digest.of(arguments)`: SHA-256 of their canonical JSON, in hexadecimal. A decision names it. */
	digest: Schema.String,
	askedAt: Schema.Number,
	/** Fixed when the request was first made; a decision that comes later is refused. */
	expiresAt: Schema.Number,
});

/** One ask: what a person is shown and decides. */
export type Request = typeof Request.Type;

/** Where a decision goes: the tool call's task and the request's id. A `Request` is one. */
export type Address = Pick<Request, "task" | "id">;

/**
 * The id of the ask number `index` (from 0) of the tool call `task` for arguments of `digest`. It is also the key the
 * decision is delivered under, so a decision reaches only the ask of exactly those arguments.
 */
export function id(task: TaskId, index: number, digest: string): string {
	return `${task}:${index}:${digest}`;
}
