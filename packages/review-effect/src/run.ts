// The run under review, as Pi stores it: Pi's built-in live and provider documents, and what a review reads of them.

import { type EntryId, LiveDoc, type LiveState, ProviderDoc, type ProviderState } from "@earendil-works/pi-durable";
import type { Doc } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";

/** What Pi's live document says of a conversation's run, as far as a review needs it. */
export interface View {
	/**
	 * Whether the conversation works on an answer now: a run is live and has not answered for good. A run that only
	 * waits for its `afterRun` tasks has.
	 */
	readonly working: boolean;
	/**
	 * The entry of the answer the run's `onYield` tasks decide about (`run.yield.answer`): Pi appended it in the commit
	 * that created them. None when no run waits for such tasks.
	 */
	readonly yielded: Option.Option<EntryId>;
	/** The run's first entry (`run.first`), kept across corrective runs; none for a run Pi recorded none for. */
	readonly first: Option.Option<EntryId>;
}

/** The view of a conversation's run in `live`, a snapshot of `Live`; none is a conversation that never ran. */
export function view(live: Option.Option<LiveState>): View {
	const run = Option.getOrUndefined(live)?.run;
	return {
		working: run !== undefined && run.afterRun === undefined,
		yielded: Option.fromUndefinedOr(run?.yield?.answer),
		first: Option.fromUndefinedOr(run?.first),
	};
}

/**
 * Pi's built-in `pi.live` document as a document of the facade, which reads through Pi's own token. Nothing here
 * writes it, and Pi's type is the type of what Pi stored.
 */
export const Live: Doc.Doc<Schema.Codec<LiveState, LiveState>, "conversation", "latest"> = {
	kind: LiveDoc.definition.kind,
	version: LiveDoc.definition.version,
	schema: Schema.declare((value: unknown): value is LiveState => typeof value === "object" && value !== null),
	scope: "conversation",
	history: "latest",
	family: false,
	token: LiveDoc,
	encode: (value) => Effect.succeed({ ...value }),
	decode: (stored) => Effect.succeed(stored as LiveState),
};

/**
 * Pi's built-in `pi.provider` document, in the same way: its `sessionId` is the provider session Pi sends with every
 * request of the conversation.
 */
export const Provider: Doc.Doc<Schema.Codec<ProviderState, ProviderState>, "conversation", "latest"> = {
	kind: ProviderDoc.definition.kind,
	version: ProviderDoc.definition.version,
	schema: Schema.Struct({ sessionId: Schema.String }),
	scope: "conversation",
	history: "latest",
	family: false,
	token: ProviderDoc,
	encode: (value) => Effect.succeed({ ...value }),
	decode: (stored) => Effect.succeed(stored as ProviderState),
};
