// The actions of a thread actor for the swarms that run on its thread: run, cancel, probe, result, the money per job,
// and the destruction of a fork. The coordinator of a swarm lives in the actor of its thread.

import { Entry, type Registry } from "@effectified/pi-durable";
import { Action } from "@effectified/pi-durable-rivet";
import * as Swarm from "@effectified/pi-swarm";
import { Array as Arr, Effect, Schema } from "effect";
import * as ForkSetup from "../fork-setup.ts";
import { ThreadKey } from "../ids.ts";
import * as Swarms from "../swarms.ts";
import * as ForkAgent from "./fork-agent.ts";
import * as SwarmId from "./swarm-id.ts";
import { crossing, Failure, OperationFailed } from "./wire.ts";

/** One swarm of the actor's thread, by its id. */
const OneSwarm = Schema.Struct({ swarmId: Swarm.SwarmId });

/**
 * What `runSwarm` takes: `Swarms.Plan` as data. `swarm` is the name of the definition, which is code and installed
 * in the actor; every job's `input` is in the JSON form of the definition's input schema, as the coordinator stores
 * it; `agent`, the change of the forks' agent, names its tools and extensions (`ForkAgent.Wire`), which are code and
 * installed in the actor too. `cap` is any finite number here: `Swarm.start` refuses one that is no integer of 1 or
 * more with its own `InvalidPlan`.
 */
const Run = Schema.Struct({
	swarm: Schema.String,
	thread: ThreadKey,
	id: Swarm.SwarmId,
	jobs: Schema.Array(Schema.Struct({ key: Swarm.JobKey, input: Schema.Json })),
	cap: Schema.Finite,
	onFailure: Schema.Literals(["fail", "collect"]),
	pins: Schema.Array(Swarm.JobKey),
	at: Schema.optionalKey(Entry.Id),
	agent: Schema.optionalKey(ForkAgent.Wire),
	fork: ForkSetup.Allowance,
});

/** What `runSwarm` takes. */
export type Run = typeof Run.Type;

/**
 * The swarm actions of a thread actor that has `swarms` installed, by name. As the thread actions, none waits and
 * each is safe to send again:
 *
 * - `runSwarm`: starts a swarm on the actor's thread and answers once its coordinator is stored. Idempotent by the
 *   swarm id: `created` is false for a swarm that existed, whose own plan stands. The id must name the thread
 *   (`SwarmId`), so that every swarm of a thread actor is found by its id alone. An agent change of the plan is
 *   stored with the swarm by its names, as `Swarm.start` stores one, and applied in each fork. A change that names
 *   a tool or an extension nothing is installed under in this actor fails with `InvalidPlan`, and nothing is stored.
 * - `cancelSwarm`: `cancelling` once the abort is durably marked, `ended` for a swarm that had ended.
 * - `probeSwarm`: whether the coordinator still runs, and the keys of the jobs it planned.
 * - `swarmResult`: the result as the coordinator stored it, values in their JSON form; none while the swarm runs.
 * - `swarmSpent`: what each job's fork settled so far, in plan order.
 * - `destroyFork`: destroys the fork of one job, a pinned one included, and answers the bytes it wrote.
 */
export function actions(swarms: ReadonlyArray<Swarm.Swarm<never, unknown>>) {
	return {
		runSwarm: Action.make({
			input: Run,
			output: Schema.Struct({ created: Schema.Boolean }),
			error: Failure,
			handler: (run) => started(swarms, run),
		}),
		cancelSwarm: Action.make({
			input: OneSwarm,
			output: Swarms.Cancelled,
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"cancelSwarm",
					Swarms.Swarms.use((service) => service.cancel(swarmId)),
				),
		}),
		probeSwarm: Action.make({
			input: OneSwarm,
			output: Swarms.Probe,
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
			output: Schema.Array(Swarms.JobSpend),
			error: Failure,
			handler: ({ swarmId }) =>
				crossing(
					"swarmSpent",
					Swarms.Swarms.use((service) => service.spent(swarmId)),
				),
		}),
		destroyFork: Action.make({
			input: Schema.Struct({ swarmId: Swarm.SwarmId, jobKey: Swarm.JobKey }),
			output: Swarm.Destroyed,
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
 * `runSwarm`: the definition `run` names, checked against what crossed, then `Swarms.run`. Each check is of wire
 * input: whoever calls, a swarm of this actor has an id that names its thread, every job's input is one the
 * definition builds its prompt from, and what the forks' agent change names is installed here.
 */
const started = Effect.fn("SwarmActions.runSwarm")(function* (
	swarms: ReadonlyArray<Swarm.Swarm<never, unknown>>,
	{ swarm: name, at, ...plan }: Run,
): Effect.fn.Return<{ readonly created: boolean }, Failure, Swarms.Swarms | Registry.Registry> {
	const swarm = yield* Effect.fromOption(
		Arr.findFirst(swarms, (installed) => installed.name === name),
		() => OperationFailed.make({ operation: "runSwarm", reason: "UnknownSwarm", message: `No swarm ${name}` }),
	);
	yield* crossing("runSwarm", SwarmId.ofThread(plan.thread, plan.id));
	yield* Effect.forEach(
		plan.jobs,
		(job) => crossing("runSwarm", swarm.work.promptOf(job.input, { swarmId: plan.id, key: job.key })),
		{ concurrency: 1, discard: true },
	);
	if (plan.agent !== undefined) yield* crossing("runSwarm", ForkAgent.requireInstalled(plan.id, plan.agent));
	const service = yield* Swarms.Swarms;
	const run = service.run(asStored(swarm), { ...plan, ...(at === undefined ? {} : { at }) });
	const result = yield* crossing("runSwarm", run);
	return { created: result.created };
});

/**
 * `swarm` for a plan whose job inputs are already in the JSON form the coordinator stores: `Swarm.start` encodes
 * each input with the definition, and what crossed the boundary is encoded.
 */
function asStored(swarm: Swarm.Swarm<never, unknown>): Swarm.Swarm<Schema.Json, unknown> {
	return { ...swarm, work: { ...swarm.work, encodeInput: (input: Schema.Json) => Effect.succeed(input) } };
}
