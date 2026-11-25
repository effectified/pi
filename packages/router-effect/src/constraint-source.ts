// The constraint port: what a product says constrains the conversation a request belongs to, asked for every request.

import { Cause, Context, Effect, Option } from "effect";
import type { Constraints } from "./constraints.ts";
import { ConstraintsUnavailable } from "./errors.ts";

/** What reaches the router with a request, and so what a source can tell a conversation by. */
export interface ConstraintRequest {
	/** The alias the request asks for. */
	readonly alias: string;
	/** pi-ai's `sessionId` of the request: Pi Durable sends a conversation's provider session with each request. */
	readonly sessionId: string | undefined;
	/** pi-ai's request `metadata` as the caller gave it, the router's own key included. */
	readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

/** What a product's constraint source does for the router. */
export interface ConstraintSourceService {
	/**
	 * The constraints the product imposes on `request`; `{}` when it imposes none. They only ever narrow what the
	 * request and the alias say (see `resolveRoutes`). A failure refuses the request: nothing is sent.
	 */
	readonly constraintsOf: (request: ConstraintRequest) => Effect.Effect<Constraints, ConstraintsUnavailable>;
}

/** The source that imposes nothing: what a router asks when the product provides no other. */
const NONE: ConstraintSourceService = { constraintsOf: () => Effect.succeed({}) };

/**
 * The product's say on each request, asked before its routes are resolved: a product that keeps a classification or
 * regions per conversation provides it with `Layer.succeed(ConstraintSource, …)` under `Router.layer`. The default
 * imposes nothing, so a router without one routes by the request and the alias alone.
 */
export const ConstraintSource: Context.Reference<ConstraintSourceService> = Context.Reference<ConstraintSourceService>(
	"@gunta/pi-router-effect/ConstraintSource",
	{ defaultValue: () => NONE },
);

/**
 * Asks `source` about `request`, failing closed: a source that fails refuses the request with its own
 * `ConstraintsUnavailable`, and one that dies refuses it with a `ConstraintsUnavailable` that names the defect. An
 * interruption stays an interruption.
 */
export function imposedBy(
	source: ConstraintSourceService,
	request: ConstraintRequest,
): Effect.Effect<Constraints, ConstraintsUnavailable> {
	return Effect.catchCause(
		Effect.suspend(() => source.constraintsOf(request)),
		(cause) => {
			if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
			const failure = Cause.findErrorOption(cause);
			if (Option.isSome(failure)) return Effect.fail(failure.value);
			const defect = Cause.squash(cause);
			const reason = `the constraint source died: ${defect instanceof Error ? defect.message : String(defect)}`;
			return Effect.fail(new ConstraintsUnavailable({ alias: request.alias, reason }));
		},
	);
}
