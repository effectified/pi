// The agent change of a swarm's forks as it crosses to the thread's actor: plain data, with tools and extensions by
// name.

import { type Agent, Registry } from "@gunta/pi-durable-effect";
import * as Swarm from "@gunta/pi-swarm-effect";
import { Effect, Schema } from "effect";

/**
 * What a caller may change of the agent of a swarm's forks through the client: all of `Agent.Change`. The model, the
 * thinking level, the instructions, the working directory, the tool rounds one run takes at most, the compaction
 * settings, and the selection of extensions and tools. A tool or an extension is given by its name or by anything
 * that carries one; only the name crosses.
 */
export type ForkAgent = Agent.Change;

/** The thinking levels a change may name: Pi's own. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies ReadonlyArray<
	NonNullable<Agent.Change["thinkingLevel"]>
>;

/** A token count of compaction settings: what Pi's `configure` takes, an integer 0 or more. */
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Compaction thresholds, each optional: Pi's `Partial<CompactionPolicy>`. */
const Policy = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	reserveTokens: Schema.optionalKey(Tokens),
	keepRecentTokens: Schema.optionalKey(Tokens),
	backgroundTokens: Schema.optionalKey(Tokens),
});

/** Pi's `CompactionSettings`: thresholds, and thresholds per `"provider/modelId"` over them. */
const Compaction = Schema.Struct({
	...Policy.fields,
	modelOverrides: Schema.optionalKey(Schema.Record(Schema.String, Policy)),
});

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
 * The numbers are those Pi's `configure` takes (turns 1 or more, token counts 0 or more, integers), so a fork is
 * never refused in its creating commit. `cwd` is a directory of the actor's environment, passed to its `env` as
 * the thread's is. The names are those of tools and extensions installed in the actor: Pi stores names, and a name
 * that is installed nowhere would select nothing, so `runSwarm` refuses one (`requireInstalled`). Whatever the
 * change says of tools, a fork is offered at most what its allowance and its thread's grant leave of them: the fork
 * setup narrows after the change is applied.
 */
export const Wire = Schema.Struct({
	model: Schema.optionalKey(Schema.NullOr(Schema.Struct({ provider: Schema.String, modelId: Schema.String }))),
	thinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.Literals(LEVELS))),
	instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
	cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
	maxTurns: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
	compaction: Schema.optionalKey(Schema.NullOr(Compaction)),
	extensions: Schema.optionalKey(Schema.NullOr(Selection)),
	tools: Schema.optionalKey(Schema.NullOr(Schema.Union([Names, Schema.Struct({ remove: Names })]))),
	modelTools: Schema.optionalKey(Schema.NullOr(Selection)),
});

/** `ForkAgent` on the wire. */
export type Wire = typeof Wire.Type;

/**
 * `agent` as it crosses: every tool and extension by its name (`Swarm.named`), checked against `Wire`. It fails with
 * `InvalidPlan` for a change that is no data of that shape, such as a number of turns below 1 or a negative token
 * count, before anything is sent. A field the type does not have, which only a cast lets through, does not cross.
 */
export function toWire(swarmId: string, agent: ForkAgent): Effect.Effect<Wire, Swarm.InvalidPlan> {
	return Effect.mapError(
		decode(Swarm.named(agent)),
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

type Edit = { readonly add?: ReadonlyArray<string>; readonly remove?: ReadonlyArray<string> };

/** Every name a selection holds, also those an edit takes away. */
function namesIn(choice: ReadonlyArray<string> | Edit | null | undefined): ReadonlyArray<string> {
	if (choice === null || choice === undefined) return [];
	return isList(choice) ? choice : [...(choice.add ?? []), ...(choice.remove ?? [])];
}

// The two forms of a selection are Pi's own, an array or an object, and carry no tag.
function isList(choice: ReadonlyArray<string> | Edit): choice is ReadonlyArray<string> {
	return Array.isArray(choice);
}
