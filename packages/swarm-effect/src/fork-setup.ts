// The fork setup port: what the product does to the conversation of a swarm's fork as it is created, such as a grant
// and a budget cap.

import { Conversation, type Tx } from "@effectified/pi-durable";
import { Context, Effect, Layer, Schema } from "effect";
import type { ForkSetupFailed } from "./errors.ts";
import { JobKey, SwarmId } from "./ids.ts";

/** The fork a setup is asked about. Every id is one of the harness storage the setup runs in. */
export const Forked = Schema.Struct({
	swarmId: SwarmId,
	/** Unique in the swarm: with `swarmId` it names the fork, and says which job spends in it. */
	jobKey: JobKey,
	/**
	 * The primed conversation the fork was made of. With the Rivet driver the setup runs inside the fork actor, where
	 * this is the copy of the primed conversation, under the id it has in the source actor.
	 */
	sourceConversationId: Conversation.Id,
	/** The conversation the job runs in, created in this commit. */
	conversationId: Conversation.Id,
});

/** The fork a setup is asked about. */
export type Forked = typeof Forked.Type;

/** What the product decides about every fork of a swarm. */
export interface ForkSetupService {
	/**
	 * Runs inside the commit that creates the conversation the job runs in, after the swarm's agent change was applied:
	 * what it writes through `tx` exists exactly when that conversation does. The conversation is a table write
	 * already, so only documents and `tx.configure` work here. A failure fails the commit: no conversation exists, and
	 * the job fails as `gone` with `reason`.
	 */
	readonly created: (tx: Tx.Tx, fork: Forked) => Effect.Effect<void, ForkSetupFailed>;
	/**
	 * Runs after that commit is stored and before the fork is given a request of its job, for what needs a commit of
	 * its own or the outside world, such as a budget cap. It may run more than once, also after a crash and before each
	 * correction of the job, so it must be idempotent. A failure fails the job as `gone` with `reason`, without a
	 * provider request.
	 */
	readonly beforeStart: (fork: Forked) => Effect.Effect<void, ForkSetupFailed>;
}

/**
 * The port. It is required: a registry with the swarm extension does not build without it, because a fork that
 * nobody decided about would run with whatever the other plugins default to, which for a budget is no cap and no
 * owner of its spend. A product that wants nothing done says so with `none`.
 *
 * Where it runs is the driver's: the in-storage driver calls it in the harness of the swarm, inside the commit that
 * forks the source conversation; the Rivet driver calls it inside the fork actor, in the commit that creates the
 * job's conversation there, so the actor's own `layer` must provide it. A driver whose forks are in no Pi harness
 * cannot call it.
 */
export class ForkSetup extends Context.Service<ForkSetup, ForkSetupService>()(
	"@effectified/pi-swarm/fork-setup/ForkSetup",
) {}

/** A setup that does nothing, for a product without guards and budgets: the stated choice, never a default. */
export const none: Layer.Layer<ForkSetup> = Layer.succeed(ForkSetup, {
	created: () => Effect.void,
	beforeStart: () => Effect.void,
});
