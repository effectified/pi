// The signal a decision travels in, and what a task record says about one of its keys.

import { Signal } from "@gunta/pi-durable-effect";
import { Decision } from "./decision.ts";

/** A decision, delivered to the tool call's task under the request's id. */
export const Decided: Signal.Signal<typeof Decision> = Signal.make("approvals.decision", 1, Decision);

/**
 * Whether the key `key` of `Decided` is settled in a task's memos: it holds a decision, or its deadline passed. Pi
 * keeps a key's state in the task's memos under `pi.signal.<signal name>/<key>` (Pi Durable specification, 5.7).
 */
export function settled(memos: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
	return memos !== undefined && Object.hasOwn(memos, `pi.signal.${Decided.name}/${key}`);
}
