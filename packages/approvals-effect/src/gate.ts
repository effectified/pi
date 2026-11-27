// The gate: a `beforeTool` hook that parks a call until a person decided about exactly the arguments it has.

import { Gate, Hook, ToolCallId, ToolName } from "@effectified/pi-durable";
import { Array as Arr, Duration, Effect, Option, Schema } from "effect";
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
export function gate<R, E>(policy: Policy<R, E>): Hook.Hook<R | Inbox> {
	const lifetime = Duration.toMillis(policy.expiresAfter);
	// Untraced: `Hook.beforeTool` runs every pass in a span of its own that names the hook, the call and its task.
	return Hook.beforeTool(
		Effect.fnUntraced(function* (call, api) {
			const asks = yield* Asks.read(api.memo);
			const last = Arr.last(asks);
			const tool = ToolName.make(call.name);
			const callId = ToolCallId.make(call.id);
			if (Option.isNone(last)) {
				const judged = { tool, arguments: call.arguments, conversation: api.conversationId, callId };
				const needed = yield* needsApproval(policy, judged);
				if (!needed) return Gate.allow;
			}
			const canonical = Digest.canonical(call.arguments);
			const digest = yield* Digest.sha256(canonical);
			const request = yield* Option.match(
				Option.filter(last, (ask) => ask.digest === digest),
				{
					onSome: Effect.succeed,
					onNone: () => made(api, { index: asks.length, tool, callId, canonical, digest, lifetime }),
				},
			);
			const state = yield* api.readSignal(Decided, request.id);
			return yield* Outcome.Outcome.match(Outcome.of(state), {
				Approved: () => Effect.succeed(Gate.allow),
				Denied: ({ note }) =>
					Effect.succeed(Gate.block(note === undefined ? "Approval denied" : `Approval denied: ${note}`)),
				Expired: () => Effect.succeed(Gate.block("The approval request expired without a decision")),
				Undecided: () =>
					Effect.as(
						Inbox.use((inbox) => inbox.publish(request)),
						Gate.park({ signals: [Decided.key(request.id)], until: request.expiresAt }),
					),
			});
		}),
	);
}

/** What a new request is made of, besides what the hook's api says. */
interface Ask {
	/** The number of the ask, from 0: how many requests the call made before. */
	readonly index: number;
	readonly tool: ToolName;
	readonly callId: ToolCallId;
	/** The canonical JSON of the arguments, and its digest. */
	readonly canonical: string;
	readonly digest: Digest.Digest;
	/** How long the request stays open, in milliseconds. */
	readonly lifetime: number;
}

/**
 * The request of `ask`, made now and stored as the ask number `index`, or the one an earlier pass stored there: Pi asks
 * again after a crash, and a request's id and expiry must not change then.
 */
const made = Effect.fnUntraced(function* (api: Hook.Api, ask: Ask) {
	const now = yield* api.now;
	// The canonical text of an object: decoding it gives the strict JSON copy of the arguments, which the tool gets.
	const strict = yield* Effect.orDie(decodeArguments(ask.canonical));
	const candidate = Request.Request.make({
		id: Request.id(api.taskId, ask.index, ask.digest),
		conversation: api.conversationId,
		task: api.taskId,
		callId: ask.callId,
		tool: ask.tool,
		arguments: strict,
		digest: ask.digest,
		askedAt: now,
		expiresAt: now + ask.lifetime,
	});
	return yield* Asks.append(api.memo, ask.index, candidate);
});

const decodeArguments = Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject));
