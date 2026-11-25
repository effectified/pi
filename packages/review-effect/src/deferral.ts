// The deferral: the signal that asks a review whose request failed to run again, and the key of each attempt.

import { Signal } from "@gunta/pi-durable-effect";
import { Schema } from "effect";

/** The signal a deferred review task sleeps on. It carries nothing: asking again is the whole message. */
export const Retried = Signal.make("review.retry", 1, Schema.Struct({}));

/**
 * The key the retry of the request number `attempt` is delivered under. One key per attempt: Pi lets a task sleep on
 * a key once, so a review that is deferred a second time waits on the next one.
 */
export function key(attempt: number): string {
	return `retry/${attempt}`;
}
