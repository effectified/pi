// A grant: the tools one conversation may call and its classification, and the document that stores it.

import { Conversation, Doc } from "@gunta/pi-durable-effect";
import { Schema } from "effect";

/**
 * What one conversation may do: exactly these tools, by name, and the classification of what it holds, one of the
 * policy's labels. A conversation without a classification is treated as above every ceiling.
 */
export const Grant = Schema.Struct({
	tools: Schema.Array(Schema.String),
	classification: Schema.optionalKey(Schema.String),
});

/** What one conversation may do. */
export type Grant = typeof Grant.Type;

/**
 * What the document holds: the grant, or `null` while the conversation was given none; and, for a conversation a task
 * owns, the conversation of that task (`owner`), whose classification bounds every grant given here.
 */
export const Stored = Schema.Struct({
	grant: Schema.NullOr(Grant),
	owner: Schema.optionalKey(Conversation.Id),
});

/**
 * The durable state of the guard for one conversation, kind `guard.grant`, in the harness storage. A fork starts with
 * the value its parent has when the fork is committed (`fork: "current"`), whatever entry it forks at: a tool taken
 * from the parent since that entry is not given back, and the parent's `owner` bounds the fork too. No other
 * conversation gets a copy.
 */
export const Document: Doc.Doc<typeof Stored, "conversation", "latest"> = Doc.make({
	kind: "guard.grant",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	schema: Stored,
	initial: () => ({ grant: null }),
	// The value is a short list: every change is stored whole.
	checkpointWhen: () => true,
});

/** `grant` as it is stored: each tool once, in the order given, and no classification key without a value. */
export function normalize(grant: Grant): Grant {
	return {
		tools: [...new Set(grant.tools)],
		...(grant.classification === undefined ? {} : { classification: grant.classification }),
	};
}

/** The grant that holds for a conversation: the stored one, or `ungranted` when it has none or no document. */
export function effective(stored: typeof Stored.Type | undefined, ungranted: Grant): Grant {
	return stored?.grant ?? ungranted;
}
