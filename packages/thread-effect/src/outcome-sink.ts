// The outcome sink port: where a product is told that a thread's work started and what the thread came to.

import { Context, Effect, Layer, Schema } from "effect";
import type { OutcomeEvent } from "./outcome-event.ts";

/** A sink could not take an event; `cause` is what the product's store failed with. The event is delivered again. */
export class OutcomeSinkError extends Schema.TaggedError<OutcomeSinkError>()("OutcomeSinkError", {
	cause: Schema.Defect(),
}) {
	override get message(): string {
		return "The outcome sink failed";
	}
}

/** What a product implements to be told of its threads' outcomes. */
export interface OutcomeSinkService {
	/**
	 * Takes one event. Success means it is stored: the composition then never delivers it again, unless the process
	 * dies before it noted so. A failure, or a death meanwhile, delivers the same event again, with the same id and
	 * the same content, so the sink must be idempotent by `OutcomeEvent.id`. The events of one thread come one at a
	 * time, in the order the thread reached them; those of different threads may come concurrently.
	 */
	readonly deliver: (event: OutcomeEvent) => Effect.Effect<void, OutcomeSinkError>;
}

/**
 * The outcome sink of this program: provided by the product, called by the composition from inside the process that
 * works the thread.
 */
export class OutcomeSink extends Context.Service<OutcomeSink, OutcomeSinkService>()(
	"@gunta/pi-thread-effect/OutcomeSink",
) {
	/**
	 * A sink that takes every event and keeps none: for a product that asks instead (`Threads.outcome`, `ended`,
	 * `Remote.threads.ended`). The events are still worked out and noted as delivered.
	 */
	static readonly none: Layer.Layer<OutcomeSink> = Layer.succeed(OutcomeSink, { deliver: () => Effect.void });
}
