// The `subagent.child` document: one per child conversation, linking it to its parent and holding how it ended.

import type { ConversationId, TaskId } from "@effectified/pi-durable";
import { Conversation, Doc, Entry, Task } from "@effectified/pi-durable";
import { Schema } from "effect";

/** Whether the parent's tool call waits for the child, or goes on without it. */
export const Mode = Schema.Literals(["foreground", "background"]);

/** Whether the parent's tool call waits for the child, or goes on without it. */
export type Mode = typeof Mode.Type;

/**
 * How far a child is. `Answered` holds the entry of its final answer, and `Typed` also that answer as the JSON form
 * of the declared result schema. `Failed` holds a `reason` for programs (Pi's own word for a run that ended without
 * an answer, such as `model_error`, `turn_limit` or `aborted`, or this package's `invalid_result` and
 * `setup_failed`) and a `message` for the parent's model; `answer` is the last answer when there was one.
 */
export const State = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal("Running") }),
	Schema.Struct({ _tag: Schema.Literal("Answered"), answer: Entry.Id }),
	Schema.Struct({ _tag: Schema.Literal("Typed"), answer: Entry.Id, result: Schema.Json }),
	Schema.Struct({
		_tag: Schema.Literal("Failed"),
		reason: Schema.String,
		message: Schema.String,
		answer: Schema.NullOr(Entry.Id),
	}),
]);

/** How far a child is. */
export type State = typeof State.Type;

/** A state a child ends in. */
export type Ended = Exclude<State, { readonly _tag: "Running" }>;

/** The state of a child that gave no result its parent can use. */
export type Failed = Extract<State, { readonly _tag: "Failed" }>;

/**
 * What is known of a child when it is created, and never changes. A type alias, not an interface: it is the seed Pi
 * creates the document from, which must be JSON.
 */
export type Link = {
	/** The child's own conversation, whose id is also the document's key. */
	conversation: ConversationId;
	/** The name of the declaration the child runs as. */
	subagent: string;
	/** The conversation whose model asked for the child. */
	parent: ConversationId;
	/** 1 for the child of a conversation that is no subagent. */
	depth: number;
	mode: Mode;
	/** The task that drives the child, and owns its conversation. */
	task: TaskId;
};

/** The stored value: the link, and the state. */
export const Record = Schema.Struct({
	conversation: Conversation.Id,
	subagent: Schema.String,
	parent: Conversation.Id,
	depth: Schema.Number,
	mode: Mode,
	task: Task.Id,
	state: State,
});

/** The stored value: the link, and the state. */
export type Record = typeof Record.Type;

/**
 * The document, one per child, in the session scope under the child's conversation id (`key`). It is what links a
 * child to its parent for a host, beside Pi's own `ConversationRecord.owner`, and what keeps a background child's
 * result readable after everything else of it ended. Session scope: no conversation fork copies it, so a fork of a
 * child is no subagent.
 */
export const Document = Doc.family({
	kind: "subagent.child",
	version: 1,
	scope: "session",
	schema: Record,
	initial: (link: Link): Record => ({ ...link, state: { _tag: "Running" } }),
	// A handful of small fields: every change is stored whole.
	checkpointWhen: () => true,
});

/** The key of a child's document, which is also the handle a parent's model quotes: the child's conversation id. */
export function key(conversationId: ConversationId): string {
	return String(conversationId);
}
