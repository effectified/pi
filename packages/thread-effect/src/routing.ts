// The routing limits of a conversation: the regions that may serve it and the labels its routes must carry.

import type { ConversationId } from "@effectified/pi-durable";
import { Doc, Harness, type Tx } from "@effectified/pi-durable";
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
export const setIn = Effect.fn("Routing.setIn")(function* (
	tx: Tx.Tx,
	conversation: ConversationId,
	routing: Routing,
): Effect.fn.Return<void, Doc.Failure> {
	const document = yield* tx.doc(Document, conversation);
	yield* document.set(routing);
});

/** Gives `conversation` the limits `from` has in this commit: for a child, which is routed as its parent is. */
export const inheritIn = Effect.fn("Routing.inheritIn")(function* (
	tx: Tx.Tx,
	conversation: ConversationId,
	from: ConversationId,
): Effect.fn.Return<void, Doc.Failure> {
	const document = yield* tx.doc(Document, from);
	const held = yield* document.get;
	yield* setIn(tx, conversation, held);
});

/**
 * The limits of `conversation` now: none of either kind for one that was given none. One committed read, for every
 * provider request the constraint source answers: untraced, since the router's own span of the request covers it.
 */
export const of = Effect.fnUntraced(function* (
	conversation: ConversationId,
): Effect.fn.Return<Routing, Doc.Failure, Harness.Harness> {
	const stored = yield* Harness.snapshot(Document, conversation);
	return Option.getOrElse(stored, (): Routing => ({}));
});
