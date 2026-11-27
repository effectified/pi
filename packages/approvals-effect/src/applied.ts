// The record of an approval on the call's result: the request asked last and what came of it, kept with the entry.

import {
	type EntryRecord,
	Hook,
	type JsonObject,
	type ToolExecutionResult,
	ToolResultEntry,
} from "@effectified/pi-durable";
import { Array as Arr, Effect, Option, Predicate, Record, Schema } from "effect";
import * as Asks from "./asks.ts";
import { MalformedState } from "./errors.ts";
import * as Outcome from "./outcome.ts";
import { Request } from "./request.ts";
import { Decided } from "./signal.ts";

/**
 * What the gate decided a call by: its last request and that request's outcome. `Approved` on a result that is no
 * error means the tool ran on that decision; `Denied` and `Expired` are on the blocked result; `Undecided` is on the
 * result of a call aborted while it waited.
 */
export const Applied = Schema.Struct({ request: Request, outcome: Outcome.Outcome });

/** What the gate decided a call by. */
export type Applied = typeof Applied.Type;

/** The key of the record in a tool result's details. */
const KEY = "approvals";

const encode = Schema.encodeEffect(Applied);

const decode = Schema.decodeUnknownEffect(Applied);

/**
 * Writes the record into the result of every call that asked, under `approvals` in the result's `details`, which Pi
 * stores in the tool result entry and the model never reads. A hook cannot commit: the result is what the tool task
 * commits for it. Details that are no object (a tool's own array or text) are left as they are, without a record; an
 * `approvals` key of the tool's own is replaced.
 */
export const record: Hook.Hook<never> = Hook.afterTool(
	// Untraced: `Hook.afterTool` runs it in a span of its own that names the hook, the call and its task.
	Effect.fnUntraced(function* (_call, result, api) {
		const asks = yield* Asks.read(api.memo);
		const request = Arr.last(asks);
		const details = result.details;
		if (Option.isNone(request) || !joinable(details)) return Option.none();
		const state = yield* api.readSignal(Decided, request.value.id);
		// A decode boundary: Effect types the JSON it encodes read-only, Pi types the same values mutable.
		const applied = (yield* encode({ request: request.value, outcome: Outcome.of(state) })) as JsonObject;
		return Option.some({ ...result, details: { ...details, [KEY]: applied } });
	}),
);

/**
 * The record on a tool result entry: none for an entry that is no tool result, or whose call never asked. It is there
 * for as long as the entry is, which compaction never removes.
 */
export const applied: (entry: EntryRecord) => Effect.Effect<Option.Option<Applied>, MalformedState> = Effect.fn(
	"Approvals.applied",
)(function* (entry) {
	const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
	const details: unknown = message?.role === "toolResult" ? message.details : undefined;
	// A trust boundary: details are JSON any tool or extension may have written.
	if (!Predicate.isObject(details) || !Record.has(details, KEY)) return Option.none();
	return yield* Effect.mapBoth(decode(details[KEY]), {
		onFailure: (error) => MalformedState.make({ where: `details.${KEY}`, reason: error.message }),
		onSuccess: Option.some,
	});
});

/** Whether a result's details can take the record: there are none, or they are an object. */
function joinable(details: ToolExecutionResult["details"]): details is JsonObject | undefined {
	return details === undefined || Predicate.isObject(details);
}
