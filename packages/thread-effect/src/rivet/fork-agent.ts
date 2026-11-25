// The agent change of a swarm's forks as it crosses to the thread's actor: plain data, with tools and extensions by
// name.

import type { Agent } from "@gunta/pi-durable-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Effect, Schema } from "effect";

/**
 * What a caller may change of the agent of a swarm's forks through the client: the model, the thinking level, the
 * instructions, the tool rounds one run takes at most, and the selection of extensions and tools. It is
 * `Agent.Change` without `cwd` and `compaction`, which stay as the thread has them. A tool or an extension is given
 * by its name or by anything that carries one; only the name crosses.
 */
export type ForkAgent = Pick<
	Agent.Change,
	"model" | "thinkingLevel" | "instructions" | "maxTurns" | "extensions" | "tools" | "modelTools"
>;

/** The thinking levels a change may name: Pi's own. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies ReadonlyArray<
	NonNullable<Agent.Change["thinkingLevel"]>
>;

/** Tools or extensions, by name. */
const Names = Schema.Array(Schema.String);

/** A list that selects exactly these, or an edit of the selection the thread has. */
const Selection = Schema.Union([
	Names,
	Schema.Struct({ add: Schema.optionalKey(Names), remove: Schema.optionalKey(Names) }),
]);

/**
 * `ForkAgent` on the wire, as the action `runSwarm` takes it. As in `Agent.Change`, a given field replaces what the
 * fork inherits from its thread, `null` clears it back to the host's default, and an absent one changes nothing.
 * The names are those of tools and extensions installed in the actor: Pi stores names, and a name that is installed
 * nowhere selects nothing. Whatever the change says of tools, a fork is offered at most what its allowance and its
 * thread's grant leave of them: the fork setup narrows after the change is applied.
 */
export const Wire = Schema.Struct({
	model: Schema.optionalKey(Schema.NullOr(Schema.Struct({ provider: Schema.String, modelId: Schema.String }))),
	thinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.Literals(LEVELS))),
	instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
	maxTurns: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
	extensions: Schema.optionalKey(Schema.NullOr(Selection)),
	tools: Schema.optionalKey(Schema.NullOr(Schema.Union([Names, Schema.Struct({ remove: Names })]))),
	modelTools: Schema.optionalKey(Schema.NullOr(Selection)),
});

/** `ForkAgent` on the wire. */
export type Wire = typeof Wire.Type;

/**
 * `agent` as it crosses: every tool and extension by its name (`Swarm.named`), checked against `Wire`. It fails with
 * `InvalidPlan` for a change that is no data of that shape, such as a number of turns below 1, before anything is
 * sent. A field the type does not have, which only a cast lets through, does not cross.
 */
export function toWire(swarmId: string, agent: ForkAgent): Effect.Effect<Wire, Swarm.InvalidPlan> {
	return Effect.mapError(
		decode(Swarm.named(agent)),
		(error) =>
			new Swarm.InvalidPlan({ swarmId, reason: `The agent change of the forks cannot cross: ${error.message}` }),
	);
}

const decode = Schema.decodeUnknownEffect(Wire);
