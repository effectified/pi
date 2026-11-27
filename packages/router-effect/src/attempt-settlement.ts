// The settlement port: what a product does with a failed attempt before another route takes it over, awaited.

import type { AssistantMessage } from "@effectified/pi-ai";
import { Cause, Context, Effect, Exit, Option, Predicate } from "effect";
import { AttemptUnsettled } from "./errors.ts";
import type { RouteEvent } from "./route-events.ts";

/** What a product's settlement does for the router. */
export interface AttemptSettlementService {
	/**
	 * Settles the attempt of `event`: one that failed after its provider billed it (`cost.micros > 0n`) and that the
	 * next route is about to take over (`fallback: true`). The router waits for it before that route is sent anything.
	 * Its value is ignored. A failure, whatever it fails with, says the attempt was **not** settled: no other route is
	 * tried and the request ends with this attempt as its last (see `AttemptUnsettled`). It runs uninterruptibly, so an
	 * attempt that ended is told also when the caller gives up meanwhile: keep it short, or give it a timeout of its
	 * own.
	 */
	readonly settle: (event: RouteEvent) => Effect.Effect<unknown, unknown>;
}

/** The settlement that does nothing: what a router calls when the product provides no other. */
const NONE: AttemptSettlementService = { settle: () => Effect.void };

/**
 * The product's turn between a failed attempt and the route that takes it over: a product with a budget charges the
 * attempt there, and provides its settlement under `Router.layer`. The default does nothing, so a router without one
 * falls back as before and its attempts are told by their route events alone.
 */
export const AttemptSettlement: Context.Reference<AttemptSettlementService> =
	Context.Reference<AttemptSettlementService>("@effectified/pi-router/AttemptSettlement", {
		defaultValue: () => NONE,
	});

/**
 * Has `port` settle the attempt of `event`, whose provider answered with `response`, failing closed: a port that
 * fails, dies or throws fails with an `AttemptUnsettled` that names the attempt, says why and keeps what the port
 * failed or died with as its `cause`. Uninterruptible, as long as the port takes.
 */
export const settledBy: (
	port: AttemptSettlementService,
	event: RouteEvent,
	response: AssistantMessage,
) => Effect.Effect<void, AttemptUnsettled> = Effect.fn("AttemptSettlement.settledBy")(function* (
	port,
	event,
	response,
) {
	// @effect-diagnostics-next-line anyUnknownInErrorContext:off the port is the product's: whatever it fails with says the attempt was not settled, and is read below as an Exit, never as a failure of this Effect
	const settled = yield* Effect.exit(Effect.suspend(() => port.settle(event)));
	if (Exit.isSuccess(settled)) return;
	const failure = Cause.findErrorOption(settled.cause);
	const cause = Option.getOrElse(failure, () => Cause.squash(settled.cause));
	const reason = Option.isSome(failure) ? textOf(cause) : `the settlement port died: ${textOf(cause)}`;
	return yield* AttemptUnsettled.make({
		alias: event.alias,
		requestId: event.requestId,
		attempt: event.attempt,
		provider: event.route.provider,
		model: event.route.model,
		reason,
		response,
		cause,
	});
}, Effect.uninterruptible);

/** What a port failed or died with, as text: the port is the product's, so it may be any value. */
function textOf(value: unknown): string {
	return Predicate.isError(value) ? value.message : String(value);
}
