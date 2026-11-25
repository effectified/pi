// Pi's built-in conversation documents as documents of this package: read through Pi's own tokens, typed by Pi.

import {
	AgentDoc,
	type AgentState,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
	ProviderDoc,
	type ProviderState,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { SchemaDecodeError } from "@gunta/pi-schema-effect";
import { Effect, Predicate, Schema } from "effect";
import type * as Doc from "./doc.ts";

/**
 * One of Pi's built-in documents. Every conversation of a harness has each of them. The value is Pi's own state type
 * and is passed through as Pi stored it: nothing is checked against a schema, so no state Pi wrote is ever rejected.
 * `schema` only carries the type; it accepts any object.
 */
export interface BuiltinDoc<T extends object, Kept extends "latest" | "rewindable">
	extends Doc.Doc<Schema.Codec<Readonly<T>>, "conversation", Kept> {
	/**
	 * Who writes the document. `pi`: Pi's built-in tasks alone, so `set` and `update` of the document opened in a commit
	 * fail with `SchemaDecodeError` and write nothing. `product`: your code may, as Pi's `configure` does.
	 */
	readonly writer: "pi" | "product";
}

/**
 * `pi.live`: the run a conversation is busy with (`run`), the running generation and its streamed partial answer, the
 * tool calls of the round, running compactions, and why the newest run ended without an answer (`runFailure`). Pi's
 * built-in tasks write it, partly in deferred commits: a value read outside a commit may be ahead of storage. Read
 * only: a product must not write it.
 */
export const live: BuiltinDoc<LiveState, "latest"> = piOwned(LiveDoc);

/**
 * `pi.provider`: the session id Pi sends to providers for this conversation, for prompt caches and session affinity. A
 * fork gets a fresh one. Read only: a product must not write it.
 */
export const provider: BuiltinDoc<ProviderState, "latest"> = piOwned(ProviderDoc);

/**
 * `pi.usage`: the conversation's own spend, per `provider/model` and per tool name. A fork starts at zero. Read only: a
 * product must not write it; a tool reports its spend in its result (`Tool.result(value, { usage })`).
 */
export const usage: BuiltinDoc<UsageState, "latest"> = piOwned(UsageDoc);

/**
 * `pi.inbox`: the submissions queued behind the current run, in id order. Read only: a product must not write it; it
 * queues with `Conversation.submit` and withdraws with `Submission.abort`.
 */
export const inbox: BuiltinDoc<InboxState, "latest"> = piOwned(InboxDoc);

/**
 * `pi.agent`: what the conversation runs with, as stored names; unset fields follow the host. Rewindable, so
 * `snapshotAsOf` reads the agent a fork at an entry would start with. The one built-in document a product may write:
 * `Conversation.configure` and `tx.configure` are Pi's own writer, which checks the change (`maxTurns`, compaction
 * settings); `set` and `update` of the opened document write the value as given, unchecked.
 */
export const agent: BuiltinDoc<AgentState, "rewindable"> = {
	...shared(AgentDoc, "rewindable"),
	writer: "product",
	encode: (value) => Effect.succeed({ ...value }),
};

/** A built-in document only Pi's tasks write: one that keeps its latest value only, and refuses `set`. */
function piOwned<T extends object>(token: Doc.Token): BuiltinDoc<T, "latest"> {
	const issue = { path: "", message: `Document ${token.definition.kind} is written by Pi alone` };
	return {
		...shared<T, "latest">(token, "latest"),
		writer: "pi",
		encode: () => Effect.fail(new SchemaDecodeError({ issues: [issue] })),
	};
}

/** What every built-in document has, whoever writes it. `token` is Pi's own, so reads go to Pi's document. */
function shared<T extends object, Kept extends "latest" | "rewindable">(
	token: Doc.Token,
	history: Kept,
): Omit<BuiltinDoc<T, Kept>, "writer" | "encode"> {
	return {
		kind: token.definition.kind,
		version: token.definition.version,
		schema: Schema.declare((value): value is Readonly<T> => Predicate.isObject(value)),
		scope: "conversation",
		history,
		family: false,
		token,
		// Pi's own type of what Pi stored, which it migrated to this version when it loaded it: nothing to check.
		decode: (stored) => Effect.succeed(stored as Readonly<T>),
	};
}
