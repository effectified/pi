// One budget at work: its ports, and the steps every charge takes on them: attribute, reserve or refuse, settle.

import type { SessionId } from "@effectified/pi-ai";
import { Clock, Effect, Option, Schema } from "effect";
import { BudgetEvents, type BudgetEventsService } from "./budget-events.ts";
import { Estimator, type EstimatorService } from "./estimator.ts";
import { Reservation } from "./ids.ts";
import { BudgetRequest, Lease, type LeaseFenced, type LeaseService, type Settlement } from "./lease.ts";
import { Micros, Prices, type PricesService } from "./price-table.ts";
import type { Refusal } from "./refusal.ts";
import { addSettled, type ShareState, type SharesService, shareOfSession } from "./shares.ts";

/** What every charge of one budget works with. */
export interface Budget {
	readonly lease: LeaseService;
	readonly estimator: EstimatorService;
	readonly prices: PricesService;
	readonly events: BudgetEventsService;
	/** Undefined for a budget without shares. */
	readonly shares: SharesService | undefined;
}

/** The budget of the context, with `shares` when it has them. */
export const gather = Effect.fn("Budget.gather")(function* (shares: SharesService | undefined) {
	const budget: Budget = {
		lease: yield* Lease,
		estimator: yield* Estimator,
		prices: yield* Prices,
		events: yield* BudgetEvents,
		shares,
	};
	return budget;
});

/** Who a charge is for: the pi-ai session it carried, and the share of that session's conversation, when it has one. */
export interface Payer {
	readonly session: SessionId | undefined;
	readonly share: ShareState | undefined;
}

/** Finds who pays for a charge of `session`: its share, when the budget has shares and the session has one. */
export const payerOf = Effect.fn("Budget.payerOf")(function* (
	budget: Budget,
	session: SessionId | undefined,
): Effect.fn.Return<Payer> {
	if (budget.shares === undefined || session === undefined) return { session, share: undefined };
	// A share that cannot be read (the harness closed, a stored value of another shape) must not let a capped
	// conversation through: the charge ends as a defect, which sends nothing.
	const share = yield* Effect.orDie(shareOfSession(budget.shares, session));
	return { session, share: Option.getOrUndefined(share) };
});

/** A reservation the lease gave: what `settle` replaces by the real cost. */
export const Reserved = Schema.Struct({
	request: BudgetRequest,
	reservation: Reservation,
	estimate: Micros,
});

/** A reservation the lease gave. */
export type Reserved = typeof Reserved.Type;

/**
 * Publishes that `request` was refused, and fails with the refusal, typed as the caller's: nothing was reserved. A
 * generator cannot yield a type parameter's own failure, so the failure follows the traced `refused` here.
 */
export function refuse<R extends Refusal>(budget: Budget, request: BudgetRequest, refusal: R): Effect.Effect<never, R> {
	return Effect.andThen(refused(budget, request, refusal), Effect.fail(refusal));
}

/** Publishes that `request` was refused. */
const refused = Effect.fn("Budget.refused")(function* (budget: Budget, request: BudgetRequest, refusal: Refusal) {
	const at = yield* Clock.currentTimeMillis;
	yield* budget.events.publish({ _tag: "Refused", request, refusal, at });
});

/**
 * Reserves `estimate` on the lease for `request` and publishes it, or refuses the request when the lease is fenced.
 * Run it uninterruptibly together with the `settle` that follows: a reservation made must be settled.
 */
export const reserve = Effect.fn("Budget.reserve")(function* (
	budget: Budget,
	request: BudgetRequest,
	estimate: bigint,
): Effect.fn.Return<Reserved, LeaseFenced> {
	const reservation = yield* Effect.catch(budget.lease.reserve(estimate, request), (fenced) =>
		refuse(budget, request, fenced),
	);
	const { currency } = budget.prices;
	const at = yield* Clock.currentTimeMillis;
	yield* budget.events.publish({ _tag: "Reserved", request, reservation, estimate, currency, at });
	return { request, reservation, estimate };
});

/**
 * Tells the lease what a reserved charge really cost, adds it to the payer's share, and publishes it. A defect of the
 * lease's `settle` ends it there: no share is changed and no `Settled` event is published.
 */
export const settle = Effect.fn("Budget.settle")(function* (
	budget: Budget,
	reserved: Reserved,
	payer: Payer,
	settlement: Settlement,
) {
	yield* budget.lease.settle(reserved.reservation, settlement);
	if (budget.shares !== undefined && payer.session !== undefined && payer.share !== undefined) {
		yield* addSettled(budget.shares, payer.session, payer.share, settlement.cost);
	}
	const { currency } = budget.prices;
	const at = yield* Clock.currentTimeMillis;
	yield* budget.events.publish({ _tag: "Settled", ...reserved, ...settlement, currency, at });
});
