// The gate: a `beforeTool` hook that parks a call until a person decided about exactly the arguments it has.

import type { JsonObject } from "@earendil-works/pi-durable";
import { Gate, Hook } from "@effectified/pi-durable";
import { Duration, Effect } from "effect";
import * as Asks from "./asks.ts";
import * as Digest from "./digest.ts";
import { Inbox } from "./inbox.ts";
import * as Outcome from "./outcome.ts";
import { needsApproval, type Policy } from "./policy.ts";
import * as Request from "./request.ts";
import { Decided } from "./signal.ts";

/**
 * The gate of `policy`. Pi asks it before a tool call runs and again on every wake, so each pass reads everything
 * from the call's task:
 *
 * - A call the policy does not name goes on. A call that needs approval makes a request for its arguments, publishes
 *   it to the `Inbox` and parks on the request's id until a decision or the expiry.
 * - A pass that finds other arguments than the last request's (a hook before this one rewrote them) makes a new
 *   request, whatever the policy says now: the decision for the old one is never read again.
 * - Approved lets the call go on; denied and expired block it, so the tool never runs.
 */
export function gate<R>(policy: Policy<R>): Hook.Hook<R | Inbox> {
	const lifetime = Duration.toMillis(policy.expiresAfter);
	return Hook.beforeTool((call, api) =>
		Effect.gen(function* () {
			const asks = yield* Asks.read(api.memo);
			const last = asks.at(-1);
			if (last === undefined) {
				const judged = {
					tool: call.name,
					arguments: call.arguments,
					conversation: api.conversationId,
					callId: call.id,
				};
				if (!(yield* needsApproval(policy, judged))) return Gate.allow;
			}
			const canonical = Digest.canonical(call.arguments);
			const digest = yield* Digest.sha256(canonical);
			const request =
				last?.digest === digest
					? last
					: yield* Effect.flatMap(api.now, (now) =>
							Asks.append(api.memo, asks.length, {
								id: Request.id(api.taskId, asks.length, digest),
								conversation: api.conversationId,
								task: api.taskId,
								callId: call.id,
								tool: call.name,
								// The canonical text of an object, built above: parsing it gives its strict JSON copy.
								arguments: JSON.parse(canonical) as JsonObject,
								digest,
								askedAt: now,
								expiresAt: now + lifetime,
							}),
						);
			const outcome = Outcome.of(yield* api.readSignal(Decided, request.id));
			switch (outcome._tag) {
				case "Approved":
					return Gate.allow;
				case "Denied":
					return Gate.block(outcome.note === undefined ? "Approval denied" : `Approval denied: ${outcome.note}`);
				case "Expired":
					return Gate.block("The approval request expired without a decision");
				case "Undecided":
					yield* Inbox.use((inbox) => inbox.publish(request));
					return Gate.park({ signals: [Decided.key(request.id)], until: request.expiresAt });
			}
		}),
	);
}
