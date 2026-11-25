// One budget at work: its ports, and the steps every charge takes on them: attribute, reserve or refuse, settle.

import { Clock, Effect, Option } from "effect";
import { BudgetEvents, type BudgetEventsService } from "./budget-events.ts";
import { Estimator, type EstimatorService } from "./estimator.ts";
import { type BudgetRequest, Lease, type LeaseFenced, type LeaseService, type Settlement } from "./lease.ts";
import { Prices, type PricesService } from "./price-table.ts";
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
export const gather = Effect.fnUntraced(function* (shares: SharesService | undefined) {
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
	readonly session: string | undefined;
	readonly share: ShareState | undefined;
}

/** Finds who pays for a charge of `session`: its share, when the budget has shares and the session has one. */
export function payerOf(budget: Budget, session: string | undefined): Effect.Effect<Payer> {
	if (budget.shares === undefined || session === undefined) return Effect.succeed({ session, share: undefined });
	// A share that cannot be read (the harness closed, a stored value of another shape) must not let a capped
	// conversation through: the charge ends as a defect, which sends nothing.
	return Effect.map(Effect.orDie(shareOfSession(budget.shares, session)), (share) => ({
		session,
		share: Option.getOrUndefined(share),
	}));
}

/** A reservation the lease gave: what `settle` replaces by the real cost. */
export interface Reserved {
	readonly request: BudgetRequest;
	readonly reservation: string;
	readonly estimate: bigint;
}

/** Publishes that `request` was refused, and fails with the refusal: nothing was reserved. */
export const refuse = Effect.fnUntraced(function* <R extends Refusal>(
	budget: Budget,
	request: BudgetRequest,
	refusal: R,
): Effect.fn.Return<never, R> {
	yield* budget.events.publish({ _tag: "Refused", request, refusal, at: yield* Clock.currentTimeMillis });
	return yield* Effect.fail(refusal);
});

/**
 * Reserves `estimate` on the lease for `request` and publishes it, or refuses the request when the lease is fenced.
 * Run it uninterruptibly together with the `settle` that follows: a reservation made must be settled.
 */
export const reserve = Effect.fnUntraced(function* (
	budget: Budget,
	request: BudgetRequest,
	estimate: bigint,
): Effect.fn.Return<Reserved, LeaseFenced> {
	const reservation = yield* Effect.catch(budget.lease.reserve(estimate, request), (fenced) =>
		refuse(budget, request, fenced),
	);
	const { currency } = budget.prices;
	yield* budget.events.publish({
		_tag: "Reserved",
		request,
		reservation,
		estimate,
		currency,
		at: yield* Clock.currentTimeMillis,
	});
	return { request, reservation, estimate };
});

/**
 * Tells the lease what a reserved charge really cost, adds it to the payer's share, and publishes it. A defect of the
 * lease's `settle` ends it there: no share is changed and no `Settled` event is published.
 */
export const settle = Effect.fnUntraced(function* (
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
	yield* budget.events.publish({
		_tag: "Settled",
		...reserved,
		...settlement,
		currency,
		at: yield* Clock.currentTimeMillis,
	});
});
