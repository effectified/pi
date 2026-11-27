// Folds over the events of an agent's run: Sinks for what `agent.stream` and `AgentLoop.stream` give.

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { Effect, Option, Sink } from "effect";

/**
 * The messages a run added, the prompts first: those of the `agent_end` event that ends a run's events, what
 * `AgentLoop.run` runs `AgentLoop.stream` into. Run it on a stream a consumer also reads (`Stream.tap` the events to a
 * UI) to get the messages as well. Pi ends every run in `agent_end`, so events that end otherwise are a defect.
 */
export const messages: Sink.Sink<AgentMessage[], AgentEvent> = Sink.reduce(
	(): Option.Option<AgentMessage[]> => Option.none(),
	(found, event: AgentEvent) => (event.type === "agent_end" ? Option.some(event.messages) : found),
).pipe(
	Sink.mapEffect(
		Option.match({
			onNone: () => Effect.die(new Error("pi-agent-core ended a run without an agent_end event")),
			onSome: Effect.succeed,
		}),
	),
);
