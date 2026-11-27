// What became of a request: the decision that came, an expiry, or nothing yet.

import type { Signal } from "@effectified/pi-durable";
import { Match, Option, Schema } from "effect";
import { Decision } from "./decision.ts";

/** The request's expiry came before a decision. */
export const Expired = Schema.TaggedStruct("Expired", {});

/** No decision came: the call still waits, or it was aborted while it waited. */
export const Undecided = Schema.TaggedStruct("Undecided", {});

/**
 * What became of a request: the decision itself (`Approved`, `Denied`), `Expired` or `Undecided`. Choose with
 * `Outcome.match`.
 */
export const Outcome = Schema.Union([Decision.cases.Approved, Decision.cases.Denied, Expired, Undecided]).pipe(
	Schema.toTaggedUnion("_tag"),
);

/** What became of a request. */
export type Outcome = typeof Outcome.Type;

const EXPIRED: Outcome = Expired.make({});

const UNDECIDED: Outcome = Undecided.make({});

/** The outcome that the state of a request's signal key means. */
export function of(state: Option.Option<Signal.State<Decision>>): Outcome {
	return Option.match(state, {
		onNone: () => UNDECIDED,
		onSome: Match.type<Signal.State<Decision>>().pipe(
			Match.discriminatorsExhaustive("kind")({ expired: () => EXPIRED, value: ({ value }): Outcome => value }),
		),
	});
}
