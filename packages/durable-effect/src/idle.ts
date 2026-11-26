// Idle without waiting: Pi Durable's idle rule applied to the live tasks of one inspection.

import type { ConversationId, ConversationRecord, TaskId, TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@effectified/pi-chord/json";
import { Effect, Option } from "effect";
import type { DurableError } from "./errors.ts";

/** What an idle read asks about: the whole harness (`Harness.waitForIdle`), or one conversation (its `waitForIdle`). */
export type Scope =
	| { readonly kind: "harness" }
	| { readonly kind: "conversation"; readonly conversationId: ConversationId };

/** The table reads the rule needs for what an inspection does not hold: an ended owner, a conversation's owner. */
export interface Reads {
	readonly task: (
		id: TaskId,
	) => Effect.Effect<Option.Option<TaskRecord<JsonValue, JsonValue, JsonValue>>, DurableError>;
	readonly conversation: (id: ConversationId) => Effect.Effect<Option.Option<ConversationRecord>, DurableError>;
}

/**
 * Whether `scope` is idle given the live tasks `live` (those of `Harness.inspect`): Pi's rule for `waitForIdle`,
 * which has no call that answers without waiting. A live task counts against a scope when walking up from it (its
 * owner tasks, then the task that owns its conversation, and so on) reaches the scope's conversation, or for the
 * harness an ownerless one, without meeting a background task, itself included. A task whose chain cannot be read
 * counts, as in Pi. `reads` are a commit's (`Tx`), so the owners are read at one point.
 */
export function quiet(
	live: ReadonlyArray<TaskRecord<JsonValue, JsonValue, JsonValue>>,
	scope: Scope,
	reads: Reads,
): Effect.Effect<boolean, DurableError> {
	return Effect.gen(function* () {
		const tasks = new Map<TaskId, Option.Option<TaskRecord<JsonValue, JsonValue, JsonValue>>>(
			live.map((record) => [record.id, Option.some(record)]),
		);
		const owners = new Map<ConversationId, Option.Option<ConversationRecord>>();
		const task = (id: TaskId) => kept(tasks, id, reads.task);
		const conversation = (id: ConversationId) => kept(owners, id, reads.conversation);
		for (const record of live) {
			let at = Option.some(record);
			let counts: boolean | undefined;
			while (counts === undefined) {
				// A record that is missing breaks the chain: Pi counts what it cannot place.
				if (Option.isNone(at)) counts = true;
				else if (at.value.background) counts = false;
				else if (at.value.owner !== undefined) at = yield* task(at.value.owner);
				else if (scope.kind === "conversation" && at.value.conversationId === scope.conversationId) counts = true;
				else {
					const found = yield* conversation(at.value.conversationId);
					if (Option.isNone(found)) counts = true;
					else if (found.value.owner === undefined) counts = scope.kind === "harness";
					else at = yield* task(found.value.owner.taskId);
				}
			}
			if (counts) return false;
		}
		return true;
	});
}

/** `read(id)`, once per id: a chain of owners is walked once per live task below it. */
function kept<K, A>(
	known: Map<K, Option.Option<A>>,
	id: K,
	read: (id: K) => Effect.Effect<Option.Option<A>, DurableError>,
): Effect.Effect<Option.Option<A>, DurableError> {
	const found = known.get(id);
	return found === undefined
		? Effect.tap(read(id), (record) => Effect.sync(() => known.set(id, record)))
		: Effect.succeed(found);
}
