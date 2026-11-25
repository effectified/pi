// The record of a budget: one event per reservation, settlement and refusal, published to a hub a product reads.

import { Context, Effect, Layer, PubSub, Schema, type Scope, Stream } from "effect";
import { BudgetRequest, Outcome } from "./lease.ts";
import { TokenUsage } from "./price-table.ts";
import { Refusal } from "./refusal.ts";

/**
 * What the budget did with one provider request. Amounts are micro units of `currency`. No event carries content.
 *
 * - `Reserved`: the lease set `estimate` aside; the request goes to the provider next.
 * - `Settled`: the request ended and the lease was told what it cost. One for every `Reserved`.
 * - `Refused`: the request was not sent, and nothing was reserved for it.
 */
export const BudgetEvent = Schema.Union([
	Schema.TaggedStruct("Reserved", {
		request: BudgetRequest,
		/** The token the lease gave. */
		reservation: Schema.String,
		estimate: Schema.BigInt,
		currency: Schema.String,
		/** Clock time in milliseconds. */
		at: Schema.Number,
	}),
	Schema.TaggedStruct("Settled", {
		request: BudgetRequest,
		reservation: Schema.String,
		estimate: Schema.BigInt,
		/** What the provider reported, also for a failed or aborted request; zeros when it reported nothing. */
		usage: TokenUsage,
		/** `usage` at the price table. */
		cost: Schema.BigInt,
		outcome: Outcome,
		currency: Schema.String,
		at: Schema.Number,
	}),
	Schema.TaggedStruct("Refused", {
		request: BudgetRequest,
		refusal: Refusal,
		at: Schema.Number,
	}),
]);

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
	"@gunta/pi-budget-effect/BudgetEvents",
) {
	/** A fresh hub with no subscriber; closing the Layer's scope ends every subscriber's Stream. */
	static readonly layer: Layer.Layer<BudgetEvents> = Layer.effect(
		BudgetEvents,
		Effect.gen(function* () {
			const hub = yield* Effect.acquireRelease(PubSub.unbounded<BudgetEvent>(), PubSub.shutdown);
			return {
				publish: (event) => Effect.asVoid(PubSub.publish(hub, event)),
				stream: Stream.fromPubSub(hub),
				subscribe: Effect.map(PubSub.subscribe(hub), Stream.fromSubscription),
			};
		}),
	);
}
