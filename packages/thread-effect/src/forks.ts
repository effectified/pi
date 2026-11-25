// Where a swarm's forks live: the choice a host makes for the composition, and what the composition asks of it.

import type { ConversationId } from "@earendil-works/pi-durable";
import { Shares } from "@gunta/pi-budget-effect";
import type { Doc, Harness } from "@gunta/pi-durable-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Context, Effect, Layer, Option } from "effect";
import type { Opened } from "./opened.ts";

/**
 * What the forks of a swarm settled of the lease, wherever they live. The swarm's driver port says where a job ran;
 * the money is the budget's, kept in the harness storage of the fork, which for a fork in another storage only the
 * choice of driver can read.
 */
export class Accounts extends Context.Service<
	Accounts,
	{
		/**
		 * What the fork of `job` of the swarm `swarmId` settled so far, in micro units. None for a job whose fork
		 * accepted no request yet, and for a fork whose storage cannot be read now.
		 */
		readonly spent: (swarmId: string, job: Swarm.JobReport) => Effect.Effect<Option.Option<bigint>, Doc.Failure>;
	}
>()("@gunta/pi-thread-effect/Forks/Accounts") {}

/**
 * One way to hold a swarm's forks. `R` is what its driver needs of the host.
 *
 * - `driver` is built before the harness opens, because the registry's coordinators need the `ForkDriver`. It may
 *   take the budget's `Shares`, and the composition's `Opened` for what it keeps in the harness storage.
 * - `attach` is built on the open harness, for a driver that works in it.
 */
export interface Forks<R> {
	readonly driver: Layer.Layer<Swarm.ForkDriver | Accounts, never, R | Shares | Opened>;
	readonly attach: Layer.Layer<never, never, Swarm.ForkDriver | Accounts | Harness.Harness>;
}

/**
 * Forks that are conversations of the harness the swarm runs in: the swarm's in-storage driver. It works in one
 * process and in a Rivet actor alike, and is what the composition takes when a host chooses nothing. A fork's money
 * is the stored share of its conversation.
 */
export const conversations: Forks<never> = {
	driver: Layer.merge(
		Swarm.ConversationForks.layer,
		Layer.effect(
			Accounts,
			Shares.use((shares) =>
				Effect.succeed({
					spent: (_swarmId: string, job: Swarm.JobReport) => {
						const here = Option.filter(job.ran, (place) => place.actorId === null);
						if (Option.isNone(here)) return Effect.succeedNone;
						// Pi brands ids in the type system only: a place holds the conversation's id as the number it is.
						const conversation = here.value.conversationId as ConversationId;
						return Effect.map(
							shares.get(conversation),
							Option.map((share) => share.settled),
						);
					},
				}),
			),
		),
	),
	attach: Swarm.ConversationForks.attach,
};
