// The record of a refusal on the call's result: what the guard decided, kept with the tool result for the host.

import { type EntryRecord, ToolResultEntry } from "@effectified/pi-durable";
import { Effect, Option, Predicate, Record, Schema, Struct } from "effect";
import { MalformedRefusal } from "./errors.ts";
import { Refusal } from "./refusal.ts";

/**
 * What the guard writes into the result of a call it kept from running: the rule, and for `argument` and
 * `argument-failed` the name of the argument rule. Never the arguments, and never what a rule gave as its reason,
 * which is the product's own text.
 */
export const Refused = Schema.Struct(Struct.pick(Refusal.fields, ["rule", "name"]));

/** What the guard writes into the result of a call it kept from running. */
export type Refused = typeof Refused.Type;

/** The key of the record in a tool result's details, which Pi stores with the result and the model never reads. */
export const KEY = "guard";

const decode = Schema.decodeUnknownEffect(Refused);

/**
 * The record on a tool result entry: none for an entry that is no tool result, or of a call the guard did not refuse.
 * It is there for as long as the entry is, across a restart and in a fork, and compaction never removes it.
 */
export const of: (entry: EntryRecord) => Effect.Effect<Option.Option<Refused>, MalformedRefusal> = Effect.fn(
	"Refused.of",
)(function* (entry) {
	const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
	return yield* fromDetails(message?.role === "toolResult" ? message.details : undefined);
});

/**
 * The record in the details of a result: none when there is none. For a nested call, which has no entry: the tool
 * that made the call reads it from the details of the result it got.
 */
export const fromDetails: (details: unknown) => Effect.Effect<Option.Option<Refused>, MalformedRefusal> = Effect.fn(
	"Refused.fromDetails",
)(function* (details) {
	// A trust boundary: details are JSON any tool or extension may have written.
	if (!Predicate.isObject(details) || !Record.has(details, KEY)) return Option.none();
	return yield* Effect.mapBoth(decode(details[KEY]), {
		onFailure: (error) => MalformedRefusal.make({ reason: error.message }),
		onSuccess: Option.some,
	});
});
