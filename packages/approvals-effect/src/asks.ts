// The asks of one tool call: its requests in the order they were made, kept in the memos of the call's task.

import type { DurableError, Hook, JsonObject } from "@effectified/pi-durable";
import { Effect, Option, Record, Schema } from "effect";
import { MalformedState } from "./errors.ts";
import { Request } from "./request.ts";

/**
 * Every request the call made so far, oldest first, read through a hook's memos. The last one is the current one:
 * the gate adds a request whenever the arguments differ from the last request's.
 */
export const read: (memo: Hook.Api["memo"]) => Effect.Effect<ReadonlyArray<Request>, DurableError | MalformedState> =
	Effect.fn("Asks.read")(function* (memo) {
		const asks: Array<Request> = [];
		while (true) {
			const stored = yield* memo(name(asks.length));
			if (Option.isNone(stored)) return asks;
			const request = yield* decode(name(asks.length), stored.value);
			asks.push(request);
		}
	});

/** The same, from the memos of a task record. */
export const ofRecord: (
	memos: Readonly<Record<string, unknown>> | undefined,
) => Effect.Effect<ReadonlyArray<Request>, MalformedState> = Effect.fn("Asks.ofRecord")(function* (memos) {
	const asks: Array<Request> = [];
	while (memos !== undefined && Record.has(memos, name(asks.length))) {
		const request = yield* decode(name(asks.length), memos[name(asks.length)]);
		asks.push(request);
	}
	return asks;
});

/**
 * Stores `candidate` as the ask number `index` unless one is stored there, and gives the stored one: Pi asks the gate
 * again after a crash, and a request's id and expiry must not change then.
 */
export const append: (
	memo: Hook.Api["memo"],
	index: number,
	candidate: Request,
) => Effect.Effect<Request, DurableError | MalformedState> = Effect.fn("Asks.append")(
	function* (memo, index, candidate) {
		// A request is JSON by construction: a failure to encode one is a defect. A decode boundary: Effect types the
		// JSON it encodes read-only, Pi types the same values mutable.
		const json = (yield* Effect.orDie(encodeRequest(candidate))) as JsonObject;
		const stored = yield* memo(name(index), json);
		return yield* decode(name(index), stored);
	},
);

/** The memo of the ask number `index`. Memos are shared by a task and all its hooks, hence the prefix. */
function name(index: number): string {
	return `approvals.ask/${index}`;
}

const encodeRequest = Schema.encodeEffect(Request);

const decodeRequest = Schema.decodeUnknownEffect(Request);

// Untraced: once per stored ask, inside the span of the read that asks for it.
const decode = Effect.fnUntraced(function* (where: string, stored: unknown) {
	return yield* Effect.mapError(decodeRequest(stored), (error) =>
		MalformedState.make({ where, reason: error.message }),
	);
});
