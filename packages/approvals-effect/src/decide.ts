// Delivering a decision: what a host calls once a person it authenticated has decided a request.

import { type DurableError, Harness, type Signal, Task, ToolTask, type Tx } from "@effectified/pi-durable";
import { Array as Arr, Effect, Match, Option, Schema } from "effect";
import * as Asks from "./asks.ts";
import type { Decision } from "./decision.ts";
import { DigestMismatch, MalformedState } from "./errors.ts";
import type { Address } from "./request.ts";
import { Decided } from "./signal.ts";

/**
 * What became of a decision a host sent:
 *
 * - `delivered`: stored with the call, which now runs or is refused by it.
 * - `already_decided`: the request holds an earlier decision, which stands.
 * - `superseded`: the call's arguments changed since, and it asks under a newer request. Nothing was stored.
 * - `gone`: no decision can reach the call any more: it ran, was refused or was aborted, or the request expired.
 * - `unknown`: there is no such tool call, or it never made this request.
 */
export const Delivery = Schema.Literals(["delivered", "already_decided", "superseded", "gone", "unknown"]);

/** What became of a decision a host sent. */
export type Delivery = typeof Delivery.Type;

/** What `decide` fails with: Pi's failures, a decision Pi refuses, another digest, or a request that does not decode. */
export type DecideError = DurableError | Signal.Failure | DigestMismatch | MalformedState;

/**
 * Delivers `decision` to the request at `request` (a `Request`, or its `task` and `id`), in one commit that checks
 * the request and stores the decision together. It fails with `DigestMismatch`, and stores nothing, when the decision
 * names another digest than the request's. Nothing checks who decided: authenticate before you call it.
 */
export const decide: (request: Address, decision: Decision) => Effect.Effect<Delivery, DecideError, Harness.Harness> =
	Effect.fn("Approvals.decide")(function* (request, decision) {
		return yield* Harness.commit((tx) => deliver(tx, request, decision));
	});

/** The checks and the signal of `decide`, in its commit. Untraced: the commit's own span covers it. */
const deliver = Effect.fnUntraced(function* (tx: Tx.Tx, request: Address, decision: Decision) {
	const task = yield* tx.task(request.task);
	if (Option.isNone(task) || task.value.kind !== ToolTask.definition.name) return "unknown" satisfies Delivery;
	// Pi drops a task's memos, its requests among them, with its outcome.
	if (Task.ended(task.value.state.status)) return "gone" satisfies Delivery;
	const asks = yield* Asks.ofRecord(task.value.memos);
	const asked = Arr.findFirst(asks, (ask) => ask.id === request.id);
	if (Option.isNone(asked)) return "unknown" satisfies Delivery;
	const { id, digest } = asked.value;
	if (digest !== decision.digest) {
		return yield* DigestMismatch.make({ request: id, expected: digest, actual: decision.digest });
	}
	if (Option.exists(Arr.last(asks), (last) => last.id !== id)) return "superseded" satisfies Delivery;
	const result = yield* tx.signal(request.task, Decided, id, decision);
	return yield* Match.value(result).pipe(
		Match.withReturnType<Effect.Effect<Delivery, MalformedState>>(),
		Match.when("delivered", () => Effect.succeed("delivered" as const)),
		Match.when("duplicate", () => Effect.succeed("already_decided" as const)),
		Match.when("closed", () => Effect.succeed("gone" as const)),
		Match.when("not_found", () => Effect.succeed("unknown" as const)),
		Match.when("invalid", () =>
			Effect.fail(MalformedState.make({ where: "decision", reason: "Pi refused its JSON form" })),
		),
		Match.exhaustive,
	);
});
