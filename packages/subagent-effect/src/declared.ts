// The declarations of one extension, made ready once: each subagent by its name, its result schema compiled.

import { SchemaConversionError } from "@gunta/pi-durable-effect";
import { Effect, Option } from "effect";
import { UnknownSubagent } from "./errors.ts";
import * as Result from "./result.ts";
import { DEFAULT_CORRECTIONS, type Subagent } from "./subagent.ts";

/** What a product declares: the subagents a parent may start, and the limits on starting them. */
export interface Config {
	readonly subagents: ReadonlyArray<Subagent>;
	/**
	 * How deep subagents may nest: 1 lets a conversation that is no subagent start children that can start none, 2
	 * lets those children start their own. A child deeper than this is refused.
	 */
	readonly maxDepth: number;
	/** How many subagents of one conversation may be working at once, foreground and background together. */
	readonly maxLive: number;
}

/** One declaration, ready to use. */
export interface Entry {
	readonly subagent: Subagent;
	/** The compiled result schema; none for a subagent whose result is its answer's text. */
	readonly typed: Option.Option<Result.Typed>;
	/** How often a child whose answer does not match is asked again. */
	readonly corrections: number;
}

/** The declarations of one extension, ready to use. */
export interface Declared {
	readonly config: Config;
	readonly entries: ReadonlyMap<string, Entry>;
}

/**
 * Makes `config` ready. Fails, and with it the registry that installs the extension, when two subagents share a name
 * or a result schema has no JSON Schema: a declaration that cannot work is found before any harness opens.
 */
export function make(config: Config): Effect.Effect<Declared, SchemaConversionError> {
	return Effect.gen(function* () {
		const entries = new Map<string, Entry>();
		for (const subagent of config.subagents) {
			if (entries.has(subagent.name)) {
				return yield* new SchemaConversionError({ reason: `Two subagents are named ${subagent.name}` });
			}
			entries.set(subagent.name, {
				subagent,
				typed:
					subagent.result === undefined
						? Option.none()
						: Option.some(yield* Result.compile(subagent, subagent.result)),
				corrections: subagent.corrections ?? DEFAULT_CORRECTIONS,
			});
		}
		return { config, entries };
	});
}

/** The declaration named `name`; fails with the names there are, for the parent's model to pick from. */
export function find(declared: Declared, name: string): Effect.Effect<Entry, UnknownSubagent> {
	const entry = declared.entries.get(name);
	return entry === undefined
		? Effect.fail(new UnknownSubagent({ subagent: name, declared: [...declared.entries.keys()] }))
		: Effect.succeed(entry);
}
