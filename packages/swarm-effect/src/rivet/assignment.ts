// The job an actor was forked for: what the driver gives the Rivet host as the fork's input, and what the fork reads.

import { Agent, Conversation, Entry } from "@effectified/pi-durable";
import { ActorInfo, type ActorKey } from "@effectified/pi-durable-rivet";
import { Effect, Option, Schema } from "effect";
import type { ForkRequest } from "../driver.ts";
import { JobKey, SwarmId } from "../ids.ts";

/**
 * One job of a swarm, as the input of the actor fork made for it: plain JSON, which the Rivet host keeps as the
 * fork's lineage input. It says where the job starts in the copied storage: the primed conversation, the entry of it
 * the job may see, and the agent change the job runs with (tools and extensions by name), null for none. The ids
 * are Pi's, numbers in their JSON form.
 */
export const Assignment = Schema.TaggedStruct("swarm.rivet.job", {
	swarmId: SwarmId,
	jobKey: JobKey,
	sourceConversationId: Conversation.Id,
	at: Entry.Id,
	agent: Schema.NullOr(Agent.ByName),
});

/** One job of a swarm, as the input of the actor fork made for it. */
export type Assignment = typeof Assignment.Type;

/** The fork input for the job of `request`. */
export function of(request: ForkRequest): Assignment {
	return Assignment.make({
		swarmId: request.swarmId,
		jobKey: request.jobKey,
		sourceConversationId: request.sourceConversationId,
		at: request.at,
		agent: Option.getOrNull(request.agent),
	});
}

/**
 * The job the actor of the context was forked for; none for an actor that is not a fork, or one a product forked
 * for a purpose of its own. A trust boundary: the input comes from whoever forked the actor.
 */
export const assigned: Effect.Effect<Option.Option<Assignment>, never, ActorInfo> = ActorInfo.use((info) =>
	Effect.succeed(Option.flatMap(info.forkInput, decode)),
);

const decode = Schema.decodeUnknownOption(Assignment);

/** The key of the actor that is the fork of the job `jobKey` of the swarm `swarmId` of the actor under `sourceKey`. */
export function forkKey(sourceKey: ActorKey, swarmId: SwarmId, jobKey: JobKey): Array<string> {
	return [...sourceKey, "swarm", swarmId, jobKey];
}
