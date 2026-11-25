// A swarm: the definition a product installs in its registry, and the plan of one swarm as data.

import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Agent, type Extension, type Task } from "@gunta/pi-durable-effect";
import { type Coordinator, coordinator } from "./coordinator.ts";
import { compile, type Definition, type Work } from "./work.ts";

/** A swarm definition made by `make`: its compiled work, and the coordinator task that runs its swarms. */
export interface Swarm<I, A> {
	readonly name: string;
	readonly work: Work<I, A>;
	/**
	 * The coordinator's task, which `extension` installs. Its result is the swarm's result as stored: read it with
	 * `Harness.waitForTaskOf(swarm.task, id)` and `typed`, or with `result`, which does both.
	 */
	readonly task: Coordinator;
}

/**
 * Defines the work of a kind of swarm: the job input, the typed result and the job prompt builder. Install it with
 * `extension`, so a harness opened after a crash finds it again by its name.
 */
export function make<I extends Task.ValueSchema, A extends Task.ValueSchema>(
	definition: Definition<I, A>,
): Swarm<I["Type"], A["Type"]> {
	const work = compile(definition);
	return { name: definition.name, work, task: coordinator(work) };
}

/** One job of a plan: a key unique in the swarm, and the input its prompt is built from. */
export interface PlannedJob<I> {
	readonly key: string;
	readonly input: I;
}

/** One swarm as data: what `start` stores, and all a coordinator needs beside its definition. */
export interface Plan<I> {
	/** The swarm id, which is the caller's idempotency key: starting the same id twice is one swarm. */
	readonly id: string;
	/** The primed conversation. The coordinator lives in it, as a background task. */
	readonly source: ConversationId;
	/** The newest entry of the source the forks see. Default: its newest entry at the moment it is idle. */
	readonly at?: EntryId;
	readonly jobs: ReadonlyArray<PlannedJob<I>>;
	/** How many forks may work at once: an integer, 1 or more. */
	readonly cap: number;
	/**
	 * `fail`: the first failed job fails the swarm, and the jobs still open are cancelled. `collect`: every job is
	 * run, and a failed one is a failure in the result.
	 */
	readonly onFailure: "fail" | "collect";
	/** The keys of the jobs whose forks are kept when the swarm ends. Default: none. */
	readonly pins?: ReadonlyArray<string>;
	/** What every fork runs with, over what the source has at `at`: a cheaper model, fewer tools. */
	readonly agent?: Agent.Change;
}

/** The extension that installs the coordinators of these definitions. It has no tool and no hook. */
export interface SwarmExtension extends Extension.Extension<readonly [], readonly [], ReadonlyArray<Coordinator>> {}

/**
 * The extension to give `Registry.layer`: one coordinator task per definition. It makes the registry require a
 * `ForkDriver`. It has no hook, so its place among the extensions does not matter.
 */
export function extension(swarms: ReadonlyArray<Swarm<never, unknown>>): SwarmExtension {
	return { name: "swarm", tasks: swarms.map((swarm) => swarm.task) };
}

/**
 * `change` with every tool and extension as its name, which is all Pi stores of one: plain JSON, so it can be kept
 * in the coordinator's input and handed to a driver in another process. The facade's `Agent.byName`.
 */
export const named: (change: Agent.Change) => Agent.ByName = Agent.byName;
