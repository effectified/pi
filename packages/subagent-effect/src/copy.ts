// The `subagent.copy` document: the mark of a storage that was copied, which ends every run the copy inherited.

import type { TaskId } from "@earendil-works/pi-durable";
import { Doc } from "@effectified/pi-durable";
import { Option, Schema } from "effect";

/** Why a run that was copied with its storage ended: the reason of its task's outcome and of its child's document. */
export const REASON = "copied";

/**
 * Written on a storage that was copied from another one (`onStorageFork`): the runs with a task id up to `through`
 * were copied with it. They belong to the storage they were copied from, and do nothing here.
 */
export const Document = Doc.make({
	kind: "subagent.copy",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ through: Schema.Number }),
	initial: () => ({ through: 0 }),
	// One number, written once per copy.
	checkpointWhen: () => true,
});

/** Whether `mark`, the stored mark if there is one, says that the task `taskId` was copied with its storage. */
export function covers(mark: Option.Option<{ readonly through: number }>, taskId: TaskId): boolean {
	return Option.isSome(mark) && taskId <= mark.value.through;
}
