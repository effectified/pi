// The record of a budget: one event per reservation, settlement and refusal, published to a hub a product reads.

import { Context, Effect, Layer, PubSub, Schema, type Scope, Stream } from "effect";
import { Reservation } from "./ids.ts";
import { BudgetRequest, Outcome } from "./lease.ts";
import { Micros, TokenUsage } from "./price-table.ts";
import { Refusal } from "./refusal.ts";

/** Clock time in epoch milliseconds, from the `Clock` service. */
const Millis = Schema.Int;

/**
 * What the budget did with one provider request. Amounts are micro units of `currency`. No event carries content.
 * `BudgetEvent.match` picks a handler per tag and `BudgetEvent.guards` tests for one.
 *
 * - `Reserved`: the lease set `estimate` aside; the request goes to the provider next.
 * - `Settled`: the request ended and the lease was told what it cost. One for every `Reserved`.
 * - `Refused`: the request was not sent, and nothing was reserved for it.
 */
export const BudgetEvent = Schema.TaggedUnion({
	Reserved: {
		request: BudgetRequest,
		/** The token the lease gave. */
		reservation: Reservation,
		estimate: Micros,
		currency: Schema.String,
		at: Millis,
	},
	Settled: {
		request: BudgetRequest,
		reservation: Reservation,
		estimate: Micros,
		/** What the provider reported, also for a failed or aborted request; zeros when it reported nothing. */
		usage: TokenUsage,
		/** `usage` at the price table. */
		cost: Micros,
		outcome: Outcome,
		currency: Schema.String,
		at: Millis,
	},
	Refused: {
		request: BudgetRequest,
		refusal: Refusal,
		at: Millis,
	},
});

/** What the budget did with one provider request. */
export type BudgetEvent = typeof BudgetEvent.Type;

/** Where budget events go and where a product reads them. */
export interface BudgetEventsService {
	/** Hands `event` to every current subscriber. Never waits and never drops: each subscriber has its own queue. */
	readonly publish: (event: BudgetEvent) => Effect.Effect<void>;
	/** The events published from the moment the Stream starts running. */
	readonly stream: Stream.Stream<BudgetEvent>;
	/** Subscribes now and returns the Stream of the events published from now on, until the scope closes. */
	readonly subscribe: Effect.Effect<Stream.Stream<BudgetEvent>, never, Scope.Scope>;
}

/** The hub of a budget's events. A subscriber that stops reading keeps its unread events in memory. */
export class BudgetEvents extends Context.Service<BudgetEvents, BudgetEventsService>()(
	"@effectified/pi-budget/budget-events/BudgetEvents",
) {
	/** A fresh hub with no subscriber; closing the Layer's scope ends every subscriber's Stream. */
	static readonly layer: Layer.Layer<BudgetEvents> = Layer.effect(
		BudgetEvents,
		Effect.gen(function* () {
			const hub = yield* Effect.acquireRelease(PubSub.unbounded<BudgetEvent>(), PubSub.shutdown);
			return BudgetEvents.of({
				publish: Effect.fn("BudgetEvents.publish")(function* (event) {
					yield* PubSub.publish(hub, event);
				}),
				stream: Stream.fromPubSub(hub),
				subscribe: Effect.map(PubSub.subscribe(hub), Stream.fromSubscription),
			});
		}),
	);
}
