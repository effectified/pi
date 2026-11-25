// The actions of a thread actor for the swarms that run on its thread: run, cancel, probe, result, the money per job,
// and the destruction of a fork. The coordinator of a swarm lives in the actor of its thread.

import type { EntryId } from "@earendil-works/pi-durable";
import { Action } from "@gunta/pi-durable-rivet-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Effect, Schema } from "effect";
import * as ForkSetup from "../fork-setup.ts";
import * as Swarms from "../swarms.ts";
import * as ForkAgent from "./fork-agent.ts";
import * as SwarmId from "./swarm-id.ts";
import { crossing, Failure, OperationFailed } from "./wire.ts";

/** One swarm of the actor's thread, by its id. */
const OneSwarm = Schema.Struct({ swarmId: Schema.String });

/**
 * What `runSwarm` takes: `Swarms.Plan` as data. `swarm` is the name of the definition, which is code and installed
 * in the actor; every job's `input` is in the JSON form of the definition's input schema, as the coordinator stores
 * it; `agent`, the change of the forks' agent, names its tools and extensions (`ForkAgent.Wire`), which are code and
 * installed in the actor too.
 */
const Run = Schema.Struct({
	swarm: Schema.String,
	thread: Schema.String,
	id: Schema.String,
	jobs: Schema.Array(Schema.Struct({ key: Schema.String, input: Schema.Json })),
	cap: Schema.Number,
	onFailure: Schema.Literals(["fail", "collect"]),
	pins: Schema.Array(Schema.String),
	at: Schema.optionalKey(Schema.Number),
	agent: Schema.optionalKey(ForkAgent.Wire),
	fork: ForkSetup.Allowance,
});

/** What `runSwarm` takes. */
export type Run = typeof Run.Type;

/** What `swarmSpent` answers: `Swarms.JobSpend` per job, in plan order. */
const Spent = Schema.Array(Schema.Struct({ key: Schema.String, settledMicros: Schema.Option(Schema.BigInt) }));

/**
 * The swarm actions of a thread actor that has `swarms` installed, by name. As the thread actions, none waits and
 * each is safe to send again:
 *
 * - `runSwarm`: starts a swarm on the actor's thread and answers once its coordinator is stored. Idempotent by the
 *   swarm id: `created` is false for a swarm that existed, whose own plan stands. The id must name the thread
 *   (`SwarmId`), so that every swarm of a thread actor is found by its id alone. An agent change of the plan is
 *   stored with the swarm by its names, as `Swarm.start` stores one, and applied in each fork.
 * - `cancelSwarm`: `cancelling` once the abort is durably marked, `ended` for a swarm that had ended.
 * - `probeSwarm`: whether the coordinator still runs, and the keys of the jobs it planned.
 * - `swarmResult`: the result as the coordinator stored it, values in their JSON form; none while the swarm runs.
 * - `swarmSpent`: what each job's fork settled so far, in plan order.
 * - `destroyFork`: destroys the fork of one job, a pinned one included, and answers the bytes it wrote.
 */
export function actions(swarms: ReadonlyArray<Swarm.Swarm<never, unknown>>) {
	const installed = (name: string) =>
		Effect.mapError(
			Effect.fromNullishOr(swarms.find((swarm) => swarm.name === name)),
			() => new OperationFailed({ operation: "runSwarm", reason: "UnknownSwarm", message: `No swarm ${name}` }),
		);
	return {
		runSwarm: Action.make({
			input: Run,
			output: Schema.Struct({ created: Schema.Boolean }),
			error: Failure,
			handler: ({ swarm: name, at, ...plan }) =>
				Effect.gen(function* () {
					const swarm = yield* installed(name);
					// Wire input: whoever calls, a swarm of this actor has an id that names its thread.
					yield* crossing("runSwarm", SwarmId.ofThread(plan.thread, plan.id));
					// Wire input: each job's input is checked against the definition, which builds its prompt from it.
					yield* Effect.forEach(
						plan.jobs,
						(job) => crossing("runSwarm", swarm.work.promptOf(job.input, { swarmId: plan.id, key: job.key })),
						{ discard: true },
					);
					const started = yield* crossing(
						"runSwarm",
						Swarms.Swarms.use((service) =>
							// Pi brands ids in the type system only: an entry id is the number it crossed as.
							service.run(asStored(swarm), { ...plan, ...(at === undefined ? {} : { at: at as EntryId }) }),
						),
					);
					return { created: started.created };
				}),
		}),
		cancelSwarm: Action.make({
			input: OneSwarm,
			output: Schema.Literals(["cancelling", "ended"]),
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"cancelSwarm",
					Swarms.Swarms.use((service) => service.cancel(swarmId)),
				),
		}),
		probeSwarm: Action.make({
			input: OneSwarm,
			output: Schema.Struct({ alive: Schema.Boolean, jobKeys: Schema.Array(Schema.String) }),
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"probeSwarm",
					Swarms.Swarms.use((service) => service.probe(swarmId)),
				),
		}),
		swarmResult: Action.make({
			input: OneSwarm,
			output: Schema.Option(Swarm.Stored),
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"swarmResult",
					Swarms.Swarms.use((service) => service.stored(swarmId)),
				),
		}),
		swarmSpent: Action.make({
			input: OneSwarm,
			output: Spent,
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"swarmSpent",
					Swarms.Swarms.use((service) => service.spent(swarmId)),
				),
		}),
		destroyFork: Action.make({
			input: Schema.Struct({ swarmId: Schema.String, jobKey: Schema.String }),
			output: Schema.Struct({ bytesWritten: Schema.Option(Schema.Number) }),
			error: Failure,
			handler: ({ swarmId, jobKey }) =>
				crossing(
					"destroyFork",
					Swarms.Swarms.use((service) => service.destroyFork(swarmId, jobKey)),
				),
		}),
	};
}

/** The swarm actions of a thread actor, as a caller's `Client.call` is typed by them. */
export type Actions = ReturnType<typeof actions>;

/**
 * `swarm` for a plan whose job inputs are already in the JSON form the coordinator stores: `Swarm.start` encodes
 * each input with the definition, and what crossed the boundary is encoded.
 */
function asStored(swarm: Swarm.Swarm<never, unknown>): Swarm.Swarm<Schema.Json, unknown> {
	return { ...swarm, work: { ...swarm.work, encodeInput: (input: Schema.Json) => Effect.succeed(input) } };
}
