// The actions a fork actor serves the driver in its source: accept a request of its job, say where one stands, and
// stop the job's work.

import type { Harness } from "@gunta/pi-durable-effect";
import { Action, type ActorInfo, type ActorSql } from "@gunta/pi-durable-rivet-effect";
import { Effect, Schema } from "effect";
import { JobStatus } from "../driver.ts";
import type { ForkSetup } from "../fork-setup.ts";
import * as Job from "./job.ts";

/** What `swarmRun` takes: one request of the job the actor was forked for. */
const RunInput = Schema.Struct({
	swarmId: Schema.String,
	jobKey: Schema.String,
	requestId: Schema.String,
	prompt: Schema.String,
});

/** What `swarmRun` answers: the conversation of the fork actor's harness the job runs in. */
const RunOutput = Schema.Struct({ conversationId: Schema.Number });

/** What `swarmJob` takes: the request to read. */
const JobInput = Schema.Struct({ requestId: Schema.String });

/**
 * The actions of the Rivet fork driver, by the names a fork actor serves them under. A type alias, not an interface:
 * the Rivet host takes a record of actions, which only an alias is assignable to.
 */
export type Actions = {
	/**
	 * Hands the fork a request of its job; answers once the request is durably accepted, with the conversation the
	 * job runs in. It runs the product's `ForkSetup` of the fork actor, so the actor's `layer` must provide one.
	 */
	readonly swarmRun: Action.Action<
		typeof RunInput,
		typeof RunOutput,
		typeof Job.JobRefused,
		Harness.Harness | ActorInfo | ActorSql | ForkSetup
	>;
	/** Where a request stands, and its answer's text once it settled. */
	readonly swarmJob: Action.Action<typeof JobInput, typeof JobStatus, typeof Schema.Never, Harness.Harness>;
	/** Stops the job's work; answers once nothing of it runs. */
	readonly swarmCancel: Action.Action<typeof Schema.Null, typeof Schema.Null, typeof Schema.Never, Harness.Harness>;
};

/**
 * The actions of the Rivet fork driver, for a product to spread into its own `Actor.make({ actions })`: the one
 * actor definition then serves as the source of a swarm and as each of its forks. The names start with `swarm`. Only
 * the driver calls them, in an actor it forked; nothing checks who calls.
 */
export const actions: Actions = {
	swarmRun: Action.make({
		input: RunInput,
		output: RunOutput,
		error: Job.JobRefused,
		handler: (request) =>
			Job.accept(request).pipe(
				Effect.map((conversationId) => ({ conversationId })),
				// A failing harness is a defect of this call: the caller asks again.
				Effect.catch((error) => (error._tag === "SwarmJobRefused" ? Effect.fail(error) : Effect.die(error))),
			),
	}),
	swarmJob: Action.make({
		input: JobInput,
		output: JobStatus,
		handler: ({ requestId }) => Effect.orDie(Job.status(requestId)),
	}),
	swarmCancel: Action.make({
		input: Schema.Null,
		output: Schema.Null,
		handler: () => Effect.as(Effect.orDie(Job.cancel), null),
	}),
};
