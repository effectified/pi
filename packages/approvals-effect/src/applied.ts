// The record of an approval on the call's result: the request asked last and what came of it, kept with the entry.

import {
	type EntryRecord,
	Hook,
	type JsonObject,
	type ToolExecutionResult,
	ToolResultEntry,
} from "@effectified/pi-durable";
import { Effect, Option, Predicate, Schema } from "effect";
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
export const record: Hook.Hook<never> = Hook.afterTool((_call, result, api) =>
	Effect.gen(function* () {
		const request = (yield* Asks.read(api.memo)).at(-1);
		const details = result.details;
		if (request === undefined || !joinable(details)) return Option.none();
		const outcome = Outcome.of(yield* api.readSignal(Decided, request.id));
		// A decode boundary: Effect types the JSON it encodes to read-only, Pi types the same values mutable.
		const applied = (yield* encode({ request, outcome })) as JsonObject;
		return Option.some({ ...result, details: { ...details, [KEY]: applied } });
	}),
);

/**
 * The record on a tool result entry: none for an entry that is no tool result, or whose call never asked. It is there
 * for as long as the entry is, which compaction never removes.
 */
export function applied(entry: EntryRecord): Effect.Effect<Option.Option<Applied>, MalformedState> {
	const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
	const details: unknown = message?.role === "toolResult" ? message.details : undefined;
	if (!Predicate.isObject(details) || !Object.hasOwn(details, KEY)) return Effect.succeedNone;
	return Effect.map(
		Effect.mapError(
			decode(details[KEY]),
			(error) => new MalformedState({ where: `details.${KEY}`, reason: error.message }),
		),
		Option.some,
	);
}

/** Whether a result's details can take the record: there are none, or they are an object. */
function joinable(details: ToolExecutionResult["details"]): details is JsonObject | undefined {
	return details === undefined || (typeof details === "object" && details !== null && !Array.isArray(details));
}
