// The requests that await a decision, read from the harness's durable state.

import { type DurableError, Harness } from "@gunta/pi-durable-effect";
import { Effect } from "effect";
import * as Asks from "./asks.ts";
import type { MalformedState } from "./errors.ts";
import type { Request } from "./request.ts";
import { settled } from "./signal.ts";

/**
 * Every request a decision can still reach, in task order: for each live tool call that asked and is not aborted, its
 * last request, unless that one is decided or expired. It reads the live task records of the harness
 * (`Harness.inspect`), where the gate keeps each request in a memo and Pi keeps the state of its signal key, so it
 * needs no `Inbox` and is the same after a restart. A call leaves the list when it is decided, expires or ends.
 */
export const pending: Effect.Effect<
	ReadonlyArray<Request>,
	DurableError | MalformedState,
	Harness.Harness
> = Effect.gen(function* () {
	const requests: Request[] = [];
	for (const { record } of (yield* Harness.inspect).tasks) {
		if (record.abortRequested) continue;
		const last = (yield* Asks.ofRecord(record.memos)).at(-1);
		if (last !== undefined && !settled(record.memos, last.id)) requests.push(last);
	}
	return requests;
});
