// A forked storage starts clean: what a host runs on a copy of a whole harness storage before its first call.

import type { ConversationId } from "@earendil-works/pi-durable";
import { type DurableError, Harness } from "@effectified/pi-durable";
import { Effect, Option, Stream } from "effect";
import { Cursor } from "./cursor.ts";

/**
 * Moves the cursor of every conversation to its newest entry, in one commit: whatever the copy holds counts as
 * delivered. Run it on a storage copied from another one (an actor fork), on a harness opened with `resume: false`,
 * before anything else and before the recorder's Layer is built.
 *
 * Why the head: the storage this one was copied from keeps running and delivers every entry the copy inherited, so a
 * copy that delivered them too would double them. Both storages number their later entries alike, so a product that
 * gives several storages one sink keys a record by its storage and the record's id, never by the id alone.
 */
export const onStorageFork: Effect.Effect<void, DurableError, Harness.Harness> = Harness.commit((tx) =>
	Effect.gen(function* () {
		// Pi's rule for a commit: every table read comes before the first write.
		const heads: Array<readonly [ConversationId, number]> = [];
		yield* Stream.runForEach(tx.conversations(), (conversation) =>
			Effect.map(tx.latestEntryId(conversation.id), (head) => {
				if (Option.isSome(head)) heads.push([conversation.id, head.value]);
			}),
		);
		const cursors = yield* tx.doc(Cursor);
		for (const [conversationId, delivered] of heads) cursors.draft[conversationId] = delivered;
	}),
);
