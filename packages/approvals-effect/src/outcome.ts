// What became of a request: the decision that came, an expiry, or nothing yet.

import type { Signal } from "@gunta/pi-durable-effect";
import { Option, Schema } from "effect";
import { Approved, type Decision, Denied } from "./decision.ts";

/** The request's expiry came before a decision. */
export const Expired = Schema.TaggedStruct("Expired", {});

/** No decision came: the call still waits, or it was aborted while it waited. */
export const Undecided = Schema.TaggedStruct("Undecided", {});

/** What became of a request: the decision itself, `Expired` or `Undecided`. */
export const Outcome = Schema.Union([Approved, Denied, Expired, Undecided]);

/** What became of a request. */
export type Outcome = typeof Outcome.Type;

/** The outcome that the state of a request's signal key means. */
export function of(state: Option.Option<Signal.State<Decision>>): Outcome {
	if (Option.isNone(state)) return { _tag: "Undecided" };
	return state.value.kind === "expired" ? { _tag: "Expired" } : state.value.value;
}
