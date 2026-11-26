// Conversation init in Effect: what a new conversation gets in the commit that creates it.

import type { ConversationId, ConversationInit } from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@effectified/pi-chord/context";
import type { Effect } from "effect";
import type { DurableError } from "./errors.ts";
import * as Tx from "./tx.ts";

/**
 * Runs inside the commit that creates a conversation (Pi's `init`), after the harness's `conversationCreated` and the
 * `agent` change: what it writes exists exactly when the conversation does. The conversation is a table write
 * already, so table reads fail with `ReadAfterWrite`; documents and writes work. A failure fails the creating commit:
 * nothing is stored, the conversation included.
 */
export type Init<E = never, R = never> = (tx: Tx.Tx, conversationId: ConversationId) => Effect.Effect<void, E, R>;

/**
 * One Pi call that creates a conversation: `create` gets Pi's `init` for `init`, to spread into its options. The
 * Effect fails with `init`'s own failure when it failed.
 */
export function creating<A, E, R>(
	init: Init<E, R> | undefined,
	create: (options: { readonly init?: ConversationInit }, context: ChordContext) => Promise<A>,
): Effect.Effect<A, E | DurableError, R> {
	return Tx.during((inside, context) =>
		create(
			init === undefined
				? {}
				: { init: (tx, conversationId) => inside(tx, (transaction) => init(transaction, conversationId)) },
			context,
		),
	);
}
