// Pi's ids as Schemas: the number Pi stores, typed with Pi's brand, for state, errors and wires that keep an id.

import type { ConversationId, EntryId, SubmissionId, TaskId } from "@earendil-works/pi-durable";
import { Schema } from "effect";

/** The schema of a conversation id: `Conversation.Id`. */
export const conversation = of<ConversationId>();

/** The schema of an entry id: `Entry.Id`. */
export const entry = of<EntryId>();

/** The schema of a submission id: `Submission.Id`. */
export const submission = of<SubmissionId>();

/** The schema of a task id: `Task.Id`. */
export const task = of<TaskId>();

/**
 * The schema of one kind of Pi id: a number in its JSON form, typed with Pi's brand. Pi brands ids in its types only
 * (`Id<Kind>` is a number with a type-level mark), so every number Pi stores is one: the refinement holds for all of
 * them, and TypeScript checks that `Id` is a number, so a change of Pi's id representation fails to compile here.
 */
function of<Id extends number>(): Schema.refine<Id, Schema.Number> {
	return Schema.Number.pipe(Schema.refine((_value: number): _value is Id => true));
}
