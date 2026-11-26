// The asks of one tool call: its requests in the order they were made, kept in the memos of the call's task.

import type { JsonObject } from "@earendil-works/pi-durable";
import type { DurableError, Hook } from "@effectified/pi-durable";
import { Effect, Option, Schema } from "effect";
import { MalformedState } from "./errors.ts";
import { Request } from "./request.ts";

/**
 * Every request the call made so far, oldest first, read through a hook's memos. The last one is the current one:
 * the gate adds a request whenever the arguments differ from the last request's.
 */
export function read(memo: Hook.Api["memo"]): Effect.Effect<ReadonlyArray<Request>, DurableError | MalformedState> {
	return Effect.gen(function* () {
		const asks: Request[] = [];
		while (true) {
			const stored = yield* memo(name(asks.length));
			if (Option.isNone(stored)) return asks;
			asks.push(yield* decode(name(asks.length), stored.value));
		}
	});
}

/** The same, from the memos of a task record. */
export function ofRecord(
	memos: Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<ReadonlyArray<Request>, MalformedState> {
	return Effect.gen(function* () {
		const asks: Request[] = [];
		while (memos !== undefined && Object.hasOwn(memos, name(asks.length))) {
			asks.push(yield* decode(name(asks.length), memos[name(asks.length)]));
		}
		return asks;
	});
}

/**
 * Stores `candidate`, a request as JSON, as the ask number `index` unless one is stored there, and gives the stored
 * one: Pi asks the gate again after a crash, and a request's id and expiry must not change then.
 */
export function append(
	memo: Hook.Api["memo"],
	index: number,
	candidate: JsonObject,
): Effect.Effect<Request, DurableError | MalformedState> {
	return Effect.flatMap(memo(name(index), candidate), (stored) => decode(name(index), stored));
}

/** The memo of the ask number `index`. Memos are shared by a task and all its hooks, hence the prefix. */
function name(index: number): string {
	return `approvals.ask/${index}`;
}

const decodeRequest = Schema.decodeUnknownEffect(Request);

function decode(where: string, stored: unknown): Effect.Effect<Request, MalformedState> {
	return Effect.mapError(decodeRequest(stored), (error) => new MalformedState({ where, reason: error.message }));
}
