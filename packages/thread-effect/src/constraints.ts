// The constraint source of the composition: what the router is told of each request, read from the grant and the
// routing limits of the conversation the request's provider session belongs to.

import type { ModelId, SessionId } from "@effectified/pi-ai";
import type { Harness } from "@effectified/pi-durable";
import { Conversations, Guard } from "@effectified/pi-guard";
import {
	type ConstraintRequest,
	ConstraintSource,
	type Constraints,
	ConstraintsUnavailable,
} from "@effectified/pi-router";
import { Array as Arr, Effect, Layer, Option } from "effect";
import * as Opened from "./opened.ts";
import * as Routing from "./routing.ts";
import * as Session from "./session.ts";

/**
 * The router's `ConstraintSource`, before the harness is open: provide it under `Router.layer`. The router takes its
 * source when it is built, which is before the harness is open: the source is built then, and every request waits
 * for the harness (`Opened`). For every request it answers, by the request's pi-ai `sessionId`:
 *
 * - `classification`: the one of the conversation's grant. A grant without one is above every ceiling, so it is
 *   answered with the highest label of the guard's policy, never with no constraint.
 * - `regions` and `requires`: the conversation's routing limits.
 *
 * It fails closed: a request that names no session, a session no conversation of this harness holds, and a
 * read that fails are each refused with `ConstraintsUnavailable`, and nothing is sent. The cost is three committed
 * document reads per provider request (the session index, the grant, the limits) and nothing kept in memory, so the
 * answer is the same in a process that just opened the storage.
 */
export const layer: Layer.Layer<never, never, Guard.Guard | Opened.Opened> = Layer.effect(
	ConstraintSource,
	Effect.gen(function* () {
		const guard = yield* Guard.Guard;
		const opened = yield* Opened.Opened;
		const constraintsOf = Effect.fn("Constraints.constraintsOf")(function* ({
			alias,
			sessionId,
		}: ConstraintRequest): Effect.fn.Return<Constraints, ConstraintsUnavailable> {
			if (sessionId === undefined) {
				return yield* ConstraintsUnavailable.make({ alias, reason: "The request names no provider session." });
			}
			return yield* Opened.on(opened, Effect.provideService(read(alias, sessionId), Guard.Guard, guard));
		});
		return { constraintsOf };
	}),
);

/** The constraints of the conversation the session `sessionId` belongs to, for a request to `alias`. */
const read: (
	alias: ModelId,
	sessionId: SessionId,
) => Effect.Effect<Constraints, ConstraintsUnavailable, Guard.Guard | Harness.Harness> = Effect.fnUntraced(
	function* (alias: ModelId, sessionId: SessionId) {
		const guard = yield* Guard.Guard;
		const conversation = yield* Session.conversationOf(sessionId);
		if (Option.isNone(conversation)) {
			return yield* ConstraintsUnavailable.make({
				alias,
				reason: "The provider session is of no known conversation.",
			});
		}
		const grant = yield* Conversations.granted(conversation.value);
		const routing = yield* Routing.of(conversation.value);
		const classification = grant.classification ?? Option.getOrUndefined(Arr.last(guard.policy.classifications));
		return { ...routing, ...(classification === undefined ? {} : { classification }) } satisfies Constraints;
	},
	// The tag only: the text of a failed read may quote what is stored.
	(effect, alias) =>
		Effect.mapError(effect, (error) =>
			error._tag === "ConstraintsUnavailable"
				? error
				: ConstraintsUnavailable.make({ alias, reason: `A read failed: ${error._tag}.` }),
		),
);
