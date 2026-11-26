// The delivery cursors: one document that says, per conversation, through which entry its records are delivered.

import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Doc, type DurableError, Entry, Harness } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";

/** A complete copy of the document is stored after this many changes, which bounds what a reopen replays. */
const CHECKPOINT_EVERY = 64;

/**
 * How far delivery got: under each conversation's id, the id of the newest entry whose records the sink took. A
 * conversation without a key has delivered nothing yet (see `start`). It is one document of the session, not one per
 * conversation: Pi takes a document's id from the counter it numbers entries with, so a document created while a run
 * goes on would shift the entry ids, and with them the record ids, by the moment of a delivery. This one is created
 * when a pump first starts on a storage. It is stored in the harness storage, so a copy of the storage carries it.
 */
export const Cursor = Doc.make({
	kind: "recorder.cursor",
	version: 1,
	scope: "session",
	schema: Schema.Record(Schema.String, Entry.Id),
	initial: () => ({}),
	checkpointWhen: (_stored, _ops, info) => info.deltasSinceBase >= CHECKPOINT_EVERY,
});

/** Creates the document when the storage has none, in a commit of its own. */
export const ensure: Effect.Effect<void, DurableError, Harness.Harness> = Harness.commit((tx) =>
	Effect.asVoid(tx.doc(Cursor)),
);

/**
 * The id of the entry after which delivery of a conversation goes on: its cursor, or, while it has none, the entry a
 * fork was forked at, because the entries up to there are its parent's to deliver. None for a conversation that is no
 * fork and has delivered nothing: delivery starts at its first entry.
 */
export function start(
	conversationId: ConversationId,
): Effect.Effect<Option.Option<EntryId>, Doc.Failure, Harness.Harness> {
	return Effect.gen(function* () {
		const cursors = yield* Harness.snapshot(Cursor);
		const delivered = Option.flatMap(cursors, (all) => Option.fromUndefinedOr(all[conversationId]));
		if (Option.isSome(delivered)) return delivered;
		// A commit that only reads: the conversation's record is a table read, which Pi gives a transaction only.
		const record = yield* Harness.commit((tx) => tx.conversation(conversationId));
		return Option.flatMap(record, (found) => Option.fromUndefinedOr(found.parent?.at));
	});
}

/**
 * Notes, in one commit, that the records of a conversation are delivered through the entry `through`. One key of the
 * document is written, through Pi's draft, so the stored change does not grow with the number of conversations.
 */
export function advance(
	conversationId: ConversationId,
	through: EntryId,
): Effect.Effect<void, DurableError, Harness.Harness> {
	return Harness.commit((tx) =>
		Effect.map(tx.doc(Cursor), (cursors) => {
			cursors.draft[conversationId] = through;
		}),
	);
}
