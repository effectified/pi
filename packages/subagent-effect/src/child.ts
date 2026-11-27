// The `subagent.child` document: one per child conversation, linking it to its parent and holding how it ended.

import type { ConversationId } from "@effectified/pi-durable";
import { Conversation, Doc, Entry, Task } from "@effectified/pi-durable";
import { Schema } from "effect";
import { Name } from "./subagent-name.ts";

/** Whether the parent's tool call waits for the child, or goes on without it. */
export const Mode = Schema.Literals(["foreground", "background"]);

/** Whether the parent's tool call waits for the child, or goes on without it. */
export type Mode = typeof Mode.Type;

/** How deep a child is: 1 for the child of a conversation that is no subagent. */
export const Depth = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * How far a child is. `Answered` holds the entry of its final answer, and `Typed` also that answer as the JSON form
 * of the declared result schema. `Failed` holds a `reason` for programs (Pi's own word for a run that ended without
 * an answer, such as `model_error`, `turn_limit` or `aborted`, or this package's `invalid_result` and
 * `setup_failed`) and a `message` for the parent's model; `answer` is the last answer when there was one. `reason`
 * stays a string: Pi may add words, which are stored and read as they come. `State.match` picks a handler per tag.
 */
export const State = Schema.TaggedUnion({
	Running: {},
	Answered: { answer: Entry.Id },
	Typed: { answer: Entry.Id, result: Schema.Json },
	Failed: { reason: Schema.String, message: Schema.String, answer: Schema.NullOr(Entry.Id) },
});

/** How far a child is. */
export type State = typeof State.Type;

/** A state a child ends in. */
export type Ended = Exclude<State, { readonly _tag: "Running" }>;

/** The state of a child that gave no result its parent can use. */
export type Failed = typeof State.cases.Failed.Type;

/**
 * The handle of a child, which its parent's model quotes and `subagent_status` reads it by: the key of its document,
 * its conversation id as text. Branded so that a subagent's name or a task text is never taken for one.
 */
export const Handle = Schema.String.pipe(Schema.brand("@effectified/pi-subagent/Handle"));

/** The handle of a child. */
export type Handle = typeof Handle.Type;

/** The stored value: what is known of a child when it is created, and never changes, and its state. */
export const Record = Schema.Struct({
	/** The child's own conversation, whose id is also the document's key. */
	conversation: Conversation.Id,
	/** The name of the declaration the child runs as. */
	subagent: Name,
	/** The conversation whose model asked for the child. */
	parent: Conversation.Id,
	depth: Depth,
	mode: Mode,
	/** The task that drives the child, and owns its conversation. */
	task: Task.Id,
	state: State,
});

/** The stored value: the link, and the state. */
export type Record = typeof Record.Type;

/** What is known of a child when it is created, and never changes: the seed Pi creates its document from. */
export type Link = Omit<Record, "state">;

/**
 * The document, one per child, in the session scope under the child's handle (`key`). It is what links a child to
 * its parent for a host, beside Pi's own `ConversationRecord.owner`, and what keeps a background child's result
 * readable after everything else of it ended. Session scope: no conversation fork copies it, so a fork of a child is
 * no subagent.
 */
export const Document = Doc.family({
	kind: "subagent.child",
	version: 1,
	scope: "session",
	schema: Record,
	initial: (link: Link): Record => ({ ...link, state: State.cases.Running.make({}) }),
	// A handful of small fields: every change is stored whole.
	checkpointWhen: () => true,
});

/** The key of a child's document, which is also the handle a parent's model quotes: the child's conversation id. */
export function key(conversationId: ConversationId): Handle {
	return Handle.make(String(conversationId));
}
