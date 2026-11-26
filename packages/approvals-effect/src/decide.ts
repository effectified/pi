// Delivering a decision: what a host calls once a person it authenticated has decided a request.

import { type DurableError, Harness, type Signal, Task, ToolTask } from "@effectified/pi-durable";
import { Effect, Option } from "effect";
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
export type Delivery = "delivered" | "already_decided" | "superseded" | "gone" | "unknown";

/**
 * Delivers `decision` to the request at `request` (a `Request`, or its `task` and `id`), in one commit that checks
 * the request and stores the decision together. It fails with `DigestMismatch`, and stores nothing, when the decision
 * names another digest than the request's. Nothing checks who decided: authenticate before you call it.
 */
export function decide(
	request: Address,
	decision: Decision,
): Effect.Effect<Delivery, DurableError | Signal.Failure | DigestMismatch | MalformedState, Harness.Harness> {
	return Harness.commit((tx) =>
		Effect.gen(function* () {
			const task = yield* tx.task(request.task);
			if (Option.isNone(task) || task.value.kind !== ToolTask.definition.name) return "unknown";
			// Pi drops a task's memos, its requests among them, with its outcome.
			if (Task.ended(task.value.state.status)) return "gone";
			const asks = yield* Asks.ofRecord(task.value.memos);
			const asked = asks.find((ask) => ask.id === request.id);
			if (asked === undefined) return "unknown";
			if (asked.digest !== decision.digest) {
				return yield* new DigestMismatch({ request: asked.id, expected: asked.digest, actual: decision.digest });
			}
			if (asked !== asks.at(-1)) return "superseded";
			const result = yield* tx.signal(request.task, Decided, asked.id, decision);
			switch (result) {
				case "delivered":
					return "delivered";
				case "duplicate":
					return "already_decided";
				case "closed":
					return "gone";
				case "not_found":
					return "unknown";
				case "invalid":
					return yield* new MalformedState({ where: "decision", reason: "Pi refused its JSON form" });
			}
		}),
	);
}
