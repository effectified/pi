// Task memos in Effect: small first-writer-wins values of the task a hook or a tool call runs for.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { Effect, Option } from "effect";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";

/**
 * A memo of one task, which its hooks and its tool share, so prefix the name. With a candidate, the first writer wins
 * and every later call gets its value: a decision that must not change when Pi runs the code again. Pi keeps memos
 * while the task can run and drops them when it ends; each write is a commit of its own.
 */
export interface Memo {
	<T extends JsonValue>(name: string): Effect.Effect<Option.Option<T>, DurableError>;
	<T extends JsonValue>(name: string, candidate: T): Effect.Effect<T, DurableError>;
}

/** A Pi api that reads and writes the memos of its task: a hook's, a tool call's. */
export interface Source {
	memo<T extends JsonValue>(name: string, context: ChordContext): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: ChordContext): Promise<T>;
}

/** The Effect form of a Pi api's memos; `parent` as for `call`. */
export function fromPi(api: Source, parent?: ChordContext): Memo {
	function memo<T extends JsonValue>(name: string): Effect.Effect<Option.Option<T>, DurableError>;
	function memo<T extends JsonValue>(name: string, candidate: T): Effect.Effect<T, DurableError>;
	function memo<T extends JsonValue>(name: string, candidate?: T): Effect.Effect<Option.Option<T> | T, DurableError> {
		// A memo is JSON, which has no `undefined`: an absent candidate is a read.
		return candidate === undefined
			? Effect.map(
					call((context) => api.memo<T>(name, context), parent),
					Option.fromUndefinedOr,
				)
			: call((context) => api.memo(name, candidate, context), parent);
	}
	return memo;
}
