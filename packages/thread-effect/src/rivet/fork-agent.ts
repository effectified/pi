// The agent change of a swarm's forks as it crosses to the thread's actor: plain data, with tools and extensions by
// name.

import { Agent, Registry } from "@gunta/pi-durable-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Effect, Schema } from "effect";

/**
 * What a caller may change of the agent of a swarm's forks through the client: all of `Agent.Change`. The model, the
 * thinking level, the instructions, the working directory, the tool rounds one run takes at most, the compaction
 * settings, and the selection of extensions and tools. A tool or an extension is given by its name or by anything
 * that carries one; only the name crosses.
 */
export type ForkAgent = Agent.Change;

/**
 * `ForkAgent` on the wire, as the action `runSwarm` takes it: the facade's `Agent.ByName`, Pi's `AgentChange` field
 * for field with tools and extensions by name. As in `Agent.Change`, a given field replaces what the fork inherits
 * from its thread, `null` clears it back to the host's default, and an absent one changes nothing. The numbers are
 * those Pi's `configure` takes (turns 1 or more, token counts 0 or more, integers), so a fork is never refused in its
 * creating commit. `cwd` is a directory of the actor's environment, passed to its `env` as the thread's is. The names
 * are those of tools and extensions installed in the actor: Pi stores names, and a name that is installed nowhere
 * would select nothing, so `runSwarm` refuses one (`requireInstalled`). Whatever the change says of tools, a fork is
 * offered at most what its allowance and its thread's grant leave of them: the fork setup narrows after the change
 * is applied.
 */
export const Wire = Agent.ByName;

/** `ForkAgent` on the wire. */
export type Wire = Agent.ByName;

/**
 * `agent` as it crosses: every tool and extension by its name (`Agent.byName`), checked against `Wire`. It fails with
 * `InvalidPlan` for a change that is no data of that shape, such as a number of turns below 1 or a negative token
 * count, before anything is sent. A field the type does not have, which only a cast lets through, does not cross.
 */
export function toWire(swarmId: string, agent: ForkAgent): Effect.Effect<Wire, Swarm.InvalidPlan> {
	return Effect.mapError(
		decode(Agent.byName(agent)),
		(error) =>
			new Swarm.InvalidPlan({ swarmId, reason: `The agent change of the forks cannot cross: ${error.message}` }),
	);
}

const decode = Schema.decodeUnknownEffect(Wire);

/**
 * Succeeds when every tool and extension `agent` names is installed in the registry of the context, the actor's, and
 * fails with an `InvalidPlan` that lists the names nothing is installed under. Wire input: in the caller's program a
 * name may stand for something this actor does not have.
 */
export function requireInstalled(
	swarmId: string,
	agent: Wire,
): Effect.Effect<void, Swarm.InvalidPlan, Registry.Registry> {
	return Registry.Registry.use((registry) => {
		const installed = registry.snapshot();
		const tools = new Set(installed.tools().map(({ tool }) => tool.name));
		const missing = [
			...namesIn(agent.extensions)
				.filter((name) => installed.extension(name) === undefined)
				.map((name) => `extension ${name}`),
			...[...namesIn(agent.tools), ...namesIn(agent.modelTools)]
				.filter((name) => !tools.has(name))
				.map((name) => `tool ${name}`),
		];
		return missing.length === 0
			? Effect.void
			: Effect.fail(
					new Swarm.InvalidPlan({
						swarmId,
						reason: `Nothing is installed under: ${[...new Set(missing)].join(", ")}`,
					}),
				);
	});
}

/** A selection of tools or extensions as it crosses: a list, an edit of lists, or `null`; absent for none. */
type Selection = Wire["extensions"] | Wire["tools"] | Wire["modelTools"];

/**
 * Every name a selection holds, also those an edit takes away: every list of an edit, whatever Pi names its keys, so
 * a key Pi adds is held against the registry too.
 */
function namesIn(choice: Selection): ReadonlyArray<string> {
	if (choice === null || choice === undefined) return [];
	return isList(choice) ? choice : Object.values(choice).flatMap((names) => names ?? []);
}

// The two forms of a selection are Pi's own, an array or an object, and carry no tag.
function isList(choice: NonNullable<Selection>): choice is ReadonlyArray<string> {
	return Array.isArray(choice);
}
