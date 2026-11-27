// The `subagent.started` document: the child a task of this package started, so that it is found again by its task.

import { Conversation, Doc, Task } from "@effectified/pi-durable";
import { Schema } from "effect";

/** A child that exists: its conversation, and the task that drives it. */
export const Started = Schema.Struct({ conversationId: Conversation.Id, task: Task.Id });

/** A child that exists. */
export type Started = typeof Started.Type;

/**
 * The document, in the scope of a task, written in the commit that creates a child at two addresses: the tool call
 * that asked for the child, so a run of that call after a crash or a park finds the child it already made instead of
 * making a second one, and the task that drives the child, which cannot be created knowing its conversation. Pi
 * retires it with its task.
 */
export const Document = Doc.make({
	kind: "subagent.started",
	version: 1,
	scope: "task",
	schema: Schema.Struct({ started: Schema.NullOr(Started) }),
	initial: () => ({ started: null }),
	checkpointWhen: () => true,
});
