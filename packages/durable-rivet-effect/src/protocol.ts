// The built-in actions every actor of this host has beside the product's: their names, and what they answer.

import { CompactionTask } from "@earendil-works/pi-durable";
import { Harness } from "@effectified/pi-durable";
import { Effect, Schema } from "effect";
import * as Action from "./action.ts";
import { lineage as lineageOfActor } from "./fork.ts";
import { WakeKeeper } from "./wake-keeper.ts";

/** The action a scheduled wake calls. The product's own actions may not be named `pi` or `destroy`. */
export const WAKE = "pi.wake";

/** The name of `status`. */
export const STATUS = "pi.status";

/** The name of `lineage`. */
export const LINEAGE = "pi.lineage";

/**
 * The action that destroys the actor. Rivet's client knows this name: it does not send the call again once the actor
 * is going, and waits until the actor is gone.
 */
export const DESTROY = "destroy";

/** The live work of a harness at one point, and when Pi next needs a running actor. */
export const Status = Schema.Struct({
	/** Live tasks: running, pending, waiting, sleeping (a parked call too), completing and blocked ones. */
	tasks: Schema.Number,
	/**
	 * Of `tasks`, the background tasks of the product and its plugins: conversation-owned tasks created with
	 * `background`, such as a swarm's coordinator. Pi's own background compaction is not one of them, since it holds a
	 * model request. A fork may copy these tasks live (see `Client.fork`); the fork's hygiene deals with the copies.
	 */
	background: Schema.Number,
	/** Queued and placed submissions that have not settled. */
	submissions: Schema.Number,
	/** Pi's `wake().active`: some task can run now or is running. */
	active: Schema.Boolean,
	/** Pi's `wake().at`: the earliest sleep not yet due, epoch milliseconds on the actor's clock. */
	at: Schema.NullOr(Schema.Number),
});

/** The live work of a harness at one point. */
export type Status = typeof Status.Type;

/**
 * Reads the status of the harness: one inspection, which runs nothing. The wake keeper settles first, so the actor's
 * schedule matches the status a caller reads.
 */
export const status = Action.make({
	input: Schema.Null,
	output: Status,
	handler: () =>
		Effect.gen(function* () {
			yield* (yield* WakeKeeper).settle;
			const { tasks, submissions } = yield* Effect.orDie(Harness.inspect);
			const wake = yield* Harness.wake;
			return {
				tasks: tasks.length,
				background: tasks.filter(({ record }) => record.background && record.kind !== PI_COMPACTION).length,
				submissions: submissions.length,
				active: wake.active,
				at: wake.at ?? null,
			};
		}),
});

// The one task of Pi's own that can be background: an automatic compaction, which summarizes with a model request.
const PI_COMPACTION = CompactionTask.definition.name;

/** Where an actor came from, as it crosses the boundary. */
export const Lineage = Schema.Struct({
	chain: Schema.Array(
		Schema.Struct({ actorId: Schema.String, key: Schema.Array(Schema.String), forkedAt: Schema.Number }),
	),
	input: Schema.Option(Schema.Json),
});

/** Reads the lineage of the actor. */
export const lineage = Action.make({ input: Schema.Null, output: Lineage, handler: () => lineageOfActor });

/** What the destroy action answers. */
export const Destroyed = Schema.Struct({
	/** The size of the actor's SQLite database when it was destroyed: its page count times its page size. */
	databaseBytes: Schema.Option(Schema.Number),
});

/** How the destroy action crosses. The actor answers it outside the harness, which it must not need to be destroyed. */
export const destroy = Action.boundary({ input: Schema.Null, output: Destroyed });
