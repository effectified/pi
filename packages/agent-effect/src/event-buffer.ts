// The buffer between pi-agent-core's events and the consumer of a Stream: Pi awaits each event it emits, so a full
// buffer holds Pi's run back until the consumer has made room.

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type Cause, Effect, Queue } from "effect";

/** How many events of a run wait for the Stream's consumer before the run waits too. */
export const EVENT_BUFFER = 16;

/**
 * The events Pi emits into `queue`, as Pi's listener: an event is taken at once while the buffer has room; else Pi
 * awaits a promise that hands it over once the consumer made room. `consumer` is aborted when the consumer left (the
 * Stream ended early or its fiber was interrupted), and `closing` completes when what runs Pi is closed (an agent's
 * scope): then the event is dropped, so a run that waits on a full buffer nobody reads, or nobody will, settles. A
 * consumer that only lags keeps every event, though the run is aborted. The promise never rejects: a listener that
 * throws fails Pi's run. Per event, so no span.
 */
export function buffered(
	queue: Queue.Enqueue<AgentEvent, Cause.Done>,
	consumer: AbortSignal,
	closing: Effect.Effect<void>,
): (event: AgentEvent) => Promise<void> | undefined {
	return (event) =>
		Queue.offerUnsafe(queue, event)
			? undefined
			: Effect.runPromiseExit(Effect.raceFirst(Queue.offer(queue, event), closing), { signal: consumer }).then(
					() => undefined,
				);
}
