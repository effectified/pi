// The runs of this package that are still at work: what `maxLive` counts and what a copied storage aborts.

import type { ConversationId, SettledTask, TaskState, Tx } from "@effectified/pi-durable";
import { Array as Arr, Effect, Record } from "effect";

/** The statuses of a task Pi has not settled: every status but that of Pi's `SettledTask`. */
type Unsettled = Exclude<TaskState<unknown, unknown>["status"], SettledTask<unknown>["state"]["status"]>;

/**
 * The statuses of a run still at work: every status of a task Pi has not settled, Pi's own split. `completing` is one
 * on purpose, although `Task.ended` counts it as ended. Pi holds a run's decided outcome as `completing` while work it
 * owns is live: its child's conversation, such as an `afterRun` hook the child's answer started. So the subagent is
 * still at work for `maxLive`, and in a copied storage an abort of the run reaches that work, which would otherwise go
 * on in the copy and send its requests. Typed by Pi's states: a status Pi adds that it does not settle fails to
 * compile here until it is listed.
 */
const AT_WORK = {
	pending: true,
	running: true,
	waiting: true,
	sleeping: true,
	completing: true,
} as const satisfies Record<Unsettled, true>;

/** The statuses `AT_WORK` lists. Pi's scan filters by one status, so a scan asks for each in turn. */
export const LIVE = Record.keys(AT_WORK);

/**
 * How many tasks of `kind` in `conversationId` are still at work, counted up to `limit` per status: enough to compare
 * with a cap of `limit`. Table reads of the commit, one after another, so they come before its first table write.
 */
export const countLive = Effect.fn("Subagents.countLive")(function* (
	tx: Tx.Tx,
	conversationId: ConversationId,
	kind: string,
	limit: number,
) {
	const pages = yield* Effect.forEach(LIVE, (status) => tx.scanTasks({ conversationId, kind, status }, limit), {
		concurrency: 1,
	});
	return Arr.reduce(pages, 0, (count, page) => count + page.items.length);
});
