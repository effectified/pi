// Pi's built-in conversation documents as documents of this package: read through Pi's own tokens, typed by Pi.

import {
	AgentDoc,
	type CommonDocDefinition,
	type DocToken,
	InboxDoc,
	type JsonObject,
	type LatestConversationSemantics,
	LiveDoc,
	NestedCallDoc,
	type NestedCallState,
	ProviderDoc,
	type RewindableConversationSemantics,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { StrictOmit } from "@effectified/pi-ai";
import { type Issue, SchemaDecodeError } from "@effectified/pi-schema";
import { Effect, Predicate, Schema } from "effect";
import type * as Doc from "./doc.ts";

/**
 * One of Pi's built-in documents. Every conversation of a harness has each of them. The value is Pi's own state type,
 * read from Pi's token, and is passed through as Pi stored it: nothing is checked against a schema, so no state Pi
 * wrote is ever rejected. `schema` only carries the type; it accepts any object. Its `history` is the token's, typed
 * as Pi types the token: `"latest" | "rewindable"` for a document Pi types as either.
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
export const live = piOwned(LiveDoc);

/**
 * `pi.provider`: the session id Pi sends to providers for this conversation, for prompt caches and session affinity. A
 * fork gets a fresh one. Read only: a product must not write it.
 */
export const provider = piOwned(ProviderDoc);

/**
 * `pi.usage`: the conversation's own spend, per `provider/model` and per tool name. A fork starts at zero. Read only: a
 * product must not write it; a tool reports its spend in its result (`Tool.result(value, { usage })`).
 */
export const usage = piOwned(UsageDoc);

/**
 * `pi.inbox`: the submissions queued behind the current run, in id order. Read only: a product must not write it; it
 * queues with `Conversation.submit` and withdraws with `Submission.abort`.
 */
export const inbox = piOwned(InboxDoc);

/**
 * `pi.agent`: what the conversation runs with, as stored names; unset fields follow the host. Rewindable, so
 * `snapshotAsOf` reads the agent a fork at an entry would start with. The one built-in document a product may write:
 * `Conversation.configure` and `tx.configure` are Pi's own writer, which checks the change (`maxTurns`, compaction
 * settings); `set` and `update` of the opened document write the value as given, unchecked.
 */
export const agent = product(AgentDoc);

/**
 * `pi.tool.nested-call`: the nested calls a tool call made, one member per call keyed by its key, in the calling tool
 * task's scope: the nested task's id, and its result once it ended (exactly what `api.callTool` succeeds with). Pi's
 * tool task writes it, and retires it with the calling task. Read only: a product must not write it.
 */
export const nestedCall: BuiltinFamily<NestedCallState> = {
	kind: NestedCallDoc.definition.kind,
	version: NestedCallDoc.definition.version,
	schema: Schema.declare((value): value is Readonly<NestedCallState> => Predicate.isObject(value)),
	scope: "task",
	history: undefined,
	family: true,
	token: NestedCallDoc,
	writer: "pi",
	initial: () => NestedCallDoc.definition.initial(null),
	encode: () => Effect.fail(new SchemaDecodeError({ issues: [writtenByPi(NestedCallDoc.definition.kind)] })),
	// As for the singletons: Pi's own type of what Pi stored.
	decode: (stored) => Effect.succeed(stored as Readonly<NestedCallState>),
};

/** One of Pi's built-in task-scoped document families, written by Pi alone, created from no seed (`null`). */
export interface BuiltinFamily<T extends object>
	extends Doc.Family<Schema.Codec<Readonly<T>>, "task", undefined, null> {
	readonly writer: "pi";
}

/** The definition of a conversation document as Pi's token of it types it. */
type Definition<T extends JsonObject> = CommonDocDefinition<T> &
	(LatestConversationSemantics | RewindableConversationSemantics);

/** A built-in document only Pi's tasks write: `set` is refused. */
function piOwned<T extends JsonObject, D extends Definition<T>>(token: DocToken<T, D>): BuiltinDoc<T, D["history"]> {
	return {
		...shared(token),
		writer: "pi",
		encode: () => Effect.fail(new SchemaDecodeError({ issues: [writtenByPi(token.definition.kind)] })),
	};
}

/** The issue a write of a document only Pi writes fails with. */
function writtenByPi(kind: string): Issue {
	return { path: "", message: `Document ${kind} is written by Pi alone` };
}

/** A built-in document your code may write: its value is stored as given. */
function product<T extends JsonObject, D extends Definition<T>>(token: DocToken<T, D>): BuiltinDoc<T, D["history"]> {
	return { ...shared(token), writer: "product", encode: (value) => Effect.succeed({ ...value }) };
}

/**
 * What every built-in document has, whoever writes it, read from Pi's token: its kind, version and history, and its
 * state type. `token` is Pi's own, so reads go to Pi's document.
 */
function shared<T extends JsonObject, D extends Definition<T>>(
	token: DocToken<T, D>,
): StrictOmit<BuiltinDoc<T, D["history"]>, "writer" | "encode"> {
	return {
		kind: token.definition.kind,
		version: token.definition.version,
		schema: Schema.declare((value): value is Readonly<T> => Predicate.isObject(value)),
		scope: "conversation",
		history: token.definition.history,
		family: false,
		token,
		// Pi's own type of what Pi stored, which it migrated to this version when it loaded it: nothing to check.
		decode: (stored) => Effect.succeed(stored as Readonly<T>),
	};
}
