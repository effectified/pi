// The session index: which conversation a provider session belongs to, kept where the conversation is created.

import type { ConversationId } from "@effectified/pi-durable";
import { BuiltinDoc, Conversation, Doc, Harness, type Tx } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";

/**
 * One document per provider session, kind `thread.session`, in the session scope: the conversation the session
 * belongs to. What reaches the model boundary with a request is pi-ai's `sessionId`, which Pi takes from the
 * conversation's `pi.provider` document, and Pi has no lookup from that id back to its conversation: without this
 * document the only way is a scan of every conversation. A conversation's session never changes, and a fork gets
 * one of its own, so a document is written once, in the commit that creates its conversation: the harness's
 * `conversationCreated` does it for every conversation, whoever creates it (see `Composition.harness`).
 */
export const Document = Doc.family({
	kind: "thread.session",
	version: 1,
	scope: "session",
	schema: Schema.Struct({ conversation: Conversation.Id }),
	// The seed is the conversation: a document exists only as the index entry of one.
	initial: (conversation: ConversationId) => ({ conversation }),
	// One small field, written once.
	checkpointWhen: () => true,
});

/**
 * Notes the provider session of `conversation`, inside the commit that creates it: what `conversationCreated` runs.
 * Pi creates `pi.provider` in that commit before the hook, so the session is there to read. Both are documents, so it
 * works after the commit's table writes.
 */
export function noteIn(tx: Tx.Tx, conversation: ConversationId): Effect.Effect<void, Doc.Failure> {
	return Effect.gen(function* () {
		const { sessionId } = yield* (yield* tx.doc(BuiltinDoc.provider, conversation)).get;
		yield* tx.doc(Document, sessionId, conversation);
	});
}

/** The conversation the provider session `session` belongs to; none for a session nothing noted. One committed read. */
export function conversationOf(
	session: string,
): Effect.Effect<Option.Option<ConversationId>, Doc.Failure, Harness.Harness> {
	return Effect.map(
		Harness.snapshot(Document, session),
		Option.map((noted) => noted.conversation),
	);
}
