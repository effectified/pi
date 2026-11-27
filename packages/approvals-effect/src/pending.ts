// The requests that await a decision, read from the harness's durable state.

import { type DurableError, Harness, Signal } from "@effectified/pi-durable";
import { Array as Arr, Effect, Option } from "effect";
import * as Asks from "./asks.ts";
import type { MalformedState } from "./errors.ts";
import type { Request } from "./request.ts";
import { Decided } from "./signal.ts";

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
	const { tasks } = yield* Harness.inspect;
	// One at a time: each step decodes memos already in memory, which concurrency would only interleave.
	const open = yield* Effect.forEach(tasks, ({ record }) => openRequest(record), { concurrency: 1 });
	return Arr.getSomes(open);
}).pipe(Effect.withSpan("Approvals.pending"));

/** A live task record, as `Harness.inspect` lists it. */
type Live = Effect.Success<typeof Harness.inspect>["tasks"][number]["record"];

/** The last request of a task, unless its call is aborted, or the request is decided or expired. */
const openRequest = Effect.fnUntraced(function* (record: Live) {
	if (record.abortRequested) return Option.none<Request>();
	const asks = yield* Asks.ofRecord(record.memos);
	const last = Arr.last(asks);
	if (Option.isNone(last)) return last;
	// A decision, or the expiry of the request, stored under its key: either way none can reach it any more. One this
	// version cannot read (another version of the signal) is stored all the same: `stateIn` fails only for a memo
	// that is there.
	const settled = yield* Effect.match(Signal.stateIn(record, Decided, last.value.id), {
		onFailure: () => true,
		onSuccess: Option.isSome,
	});
	return settled ? Option.none<Request>() : last;
});
