// The `subagent.started` document: the child a task of this package started, so that it is found again by its task.

import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { Doc, Task } from "@gunta/pi-durable-effect";
import { Schema } from "effect";
import { ConversationIdSchema } from "./pi.ts";

/** A child that exists: its conversation, and the task that drives it. */
export interface Started {
	readonly conversationId: ConversationId;
	readonly task: TaskId;
}

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
	schema: Schema.Struct({
		started: Schema.NullOr(Schema.Struct({ conversationId: ConversationIdSchema, task: Task.Id })),
	}),
	initial: () => ({ started: null }),
	checkpointWhen: () => true,
});
