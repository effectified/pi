// What this package needs of Pi and the facade does not give: schemas of ids, the settlement signal, a task scan.

import {
	type ConversationId,
	type EntryId,
	type SettledSubmissionRecord,
	type SignalState,
	SubmissionSettled,
} from "@earendil-works/pi-durable";
import { type DurableError, ParentContext, type Signal, type Tx, UnexpectedError } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";

/**
 * The schema of a conversation id, for a document that keeps one. Pi brands ids in the type system only, which a
 * schema cannot express: at run time an id is the number stored. The facade has `Task.Id` for a task id.
 */
export const ConversationIdSchema = Schema.Number as unknown as Schema.Codec<ConversationId, number>;

/** The schema of an entry id, as `ConversationIdSchema`. */
export const EntryIdSchema = Schema.Number as unknown as Schema.Codec<EntryId, number>;

/**
 * One wait for the settlement of a submission made with `notify: { taskId, key }`: Pi's built-in `SubmissionSettled`
 * under `key`, as a key a task sleeps on.
 */
export function settlement(key: string): Signal.Key {
	return { signal: { token: Effect.succeed(SubmissionSettled) }, key };
}

/** The settled record Pi delivered to the task of `runtime` under `key`; none while the submission is open. */
export function settled(
	runtime: Signal.Reader,
	key: string,
): Effect.Effect<Option.Option<SettledSubmissionRecord>, DurableError> {
	return Effect.map(
		Effect.flatMap(Effect.service(ParentContext), (context) =>
			promised(() => runtime.readSignal(SubmissionSettled, key, context)),
		),
		// A sleep without a deadline never expires, so a state that is no value is as good as none.
		(state: SignalState<SettledSubmissionRecord> | undefined) =>
			state?.kind === "value" ? Option.some(state.value) : Option.none(),
	);
}

/** The statuses of a task that has not ended. */
const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;

/**
 * How many tasks of `kind` in `conversationId` have not ended, counted up to `limit` per status: enough to compare
 * with a cap of `limit`. Table reads of the commit, so they come before its first table write.
 */
export function countLive(
	tx: Tx.Tx,
	conversationId: ConversationId,
	kind: string,
	limit: number,
): Effect.Effect<number, DurableError> {
	return Effect.map(
		Effect.forEach(LIVE, (status) => promised(() => tx.pi.scanTasks({ conversationId, kind, status }, limit))),
		(pages) => pages.reduce((count, page) => count + page.items.length, 0),
	);
}

/** One of Pi's promises as an Effect. The facade's own bridge is not exported, so a rejection is `UnexpectedError`. */
function promised<A>(run: () => Promise<A>): Effect.Effect<A, DurableError> {
	return Effect.tryPromise({ try: run, catch: (cause) => new UnexpectedError({ cause }) });
}
