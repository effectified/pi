// The routing limits of a conversation: the regions that may serve it and the labels its routes must carry.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Doc, Harness, type Tx } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";

/**
 * What a product says of a thread's routes beside the classification of its grant: `regions`, the regions that may
 * serve its requests (absent: any), and `requires`, the labels a route must carry, every one of them, such as a
 * product's label for zero data retention (absent: none). Both mean what the route table of the router says.
 */
export const Routing = Schema.Struct({
	regions: Schema.optionalKey(Schema.Array(Schema.String)),
	requires: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** What a product says of a thread's routes beside the classification of its grant. */
export type Routing = typeof Routing.Type;

/**
 * The limits of one conversation, kind `thread.routing`, in the harness storage. A fork starts with the value its
 * parent has when the fork is committed (`fork: "current"`), as it starts with its parent's grant, so a swarm's fork
 * is routed as the thread it was made of. No other conversation gets a copy: a child is given its parent's with
 * `inheritIn`.
 */
export const Document: Doc.Doc<typeof Routing, "conversation", "latest"> = Doc.make({
	kind: "thread.routing",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	schema: Routing,
	initial: () => ({}),
	// Two short lists: every change is stored whole.
	checkpointWhen: () => true,
});

/** Gives `conversation` the limits `routing`, inside the caller's commit. */
export function setIn(tx: Tx.Tx, conversation: ConversationId, routing: Routing): Effect.Effect<void, Doc.Failure> {
	return Effect.flatMap(tx.doc(Document, conversation), (document) => document.set(routing));
}

/** Gives `conversation` the limits `from` has in this commit: for a child, which is routed as its parent is. */
export function inheritIn(
	tx: Tx.Tx,
	conversation: ConversationId,
	from: ConversationId,
): Effect.Effect<void, Doc.Failure> {
	return Effect.gen(function* () {
		const held = yield* (yield* tx.doc(Document, from)).get;
		yield* setIn(tx, conversation, held);
	});
}

/** The limits of `conversation` now: none of either kind for one that was given none. One committed read. */
export function of(conversation: ConversationId): Effect.Effect<Routing, Doc.Failure, Harness.Harness> {
	return Effect.map(
		Harness.snapshot(Document, conversation),
		Option.getOrElse((): Routing => ({})),
	);
}
