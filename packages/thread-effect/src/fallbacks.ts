// Settling the attempts another route takes over: the router's settlement port, implemented with the budget's `Spend`.

import { Spend, SpendKey } from "@effectified/pi-budget";
import { AttemptSettlement, type RouteEvent } from "@effectified/pi-router";
import { Effect, Layer } from "effect";

/**
 * The router's `AttemptSettlement` of the composition: every route attempt that failed after its provider billed it,
 * and that the next route is about to take over, is charged to the lease and to the share of the conversation whose
 * session the request named, before that route is sent anything. One request of the harness is one reservation,
 * settled with the usage of its last attempt: an earlier attempt that used tokens is known to the router alone, so
 * without this the lease is told less than the providers billed.
 *
 * - **Which attempts.** Exactly those the router hands over, with no filter here: never a request's last attempt,
 *   which the budgeted `Models` settles, and never one that cost nothing.
 * - **Once.** The key is the attempt's own name, the request id and the attempt number. The charge also carries
 *   the key of what the request asked (`requestKey`), which its own reservation has: the lease sees both as one
 *   request's.
 * - **In order.** The router waits for the settlement, so the lease is told inside the request: `reserve` for the
 *   request, `reserve` and `settle` for the failed attempt, `settle` for the request. An outcome read as the thread
 *   ends has the attempt.
 * - **Fail closed.** A record the lease refuses (`LeaseFenced`) or cannot price fails the settlement: the router
 *   tries no other route and ends the request with the failed route's own message, which the budget settles with
 *   the request's own reservation. Nothing is dropped.
 * - **Limit.** The router and the keys the budget has seen are in memory: a process that dies between a provider's
 *   failure and the end of the settlement leaves that attempt settled by nobody.
 *
 * Provide it under `Router.layer`, which takes the settlement of the context it is built in, with the budget's Layer
 * under it for `Spend`.
 */
export const layer = Layer.effect(
	AttemptSettlement,
	Effect.gen(function* () {
		const spend = yield* Spend;
		const settle = Effect.fn("Fallbacks.settle")(function* (event: RouteEvent) {
			return yield* spend.record({
				// The attempt's own name: the request id and the attempt number.
				key: SpendKey.make(`${event.requestId}#${event.attempt}`),
				provider: event.route.provider,
				model: event.route.model,
				session: event.sessionId,
				requestKey: event.requestKey,
				usage: event.usage,
				outcome: "failed",
			});
		});
		return AttemptSettlement.of({ settle });
	}),
);
