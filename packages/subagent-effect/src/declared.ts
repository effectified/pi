// The declarations of one extension, made ready once: each subagent by its name, its result schema compiled.

import { SchemaConversionError } from "@effectified/pi-durable";
import { Array as Arr, Effect, HashMap, Option, Schema } from "effect";
import { Count, UnknownSubagent } from "./errors.ts";
import * as Result from "./result.ts";
import { DEFAULT_CORRECTIONS, type Name, type Subagent } from "./subagent.ts";

/**
 * What a product declares: the subagents a parent may start, and the limits on starting them. An interface: the
 * declarations hold their result `Schema`s, which are no data.
 */
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

/** The declarations of one extension, ready to use: each by its name. */
export interface Declared {
	readonly config: Config;
	readonly entries: HashMap.HashMap<Name, Entry>;
}

/**
 * Makes `config` ready. Fails, and with it the registry that installs the extension, when a limit is not a whole
 * number of 0 or more, two subagents share a name, or a result schema has no JSON Schema: a declaration that cannot
 * work is found before any harness opens.
 */
export const make = Effect.fn("Subagents.declare")(function* (config: Config) {
	yield* decodeLimits({ maxDepth: config.maxDepth, maxLive: config.maxLive }).pipe(
		Effect.mapError((error) => SchemaConversionError.make({ reason: `maxDepth and maxLive: ${error.message}` })),
	);
	let entries = HashMap.empty<Name, Entry>();
	for (const subagent of config.subagents) {
		if (HashMap.has(entries, subagent.name)) {
			return yield* SchemaConversionError.make({ reason: `Two subagents are named ${subagent.name}` });
		}
		const typed = yield* typedOf(subagent);
		const corrections = subagent.corrections ?? DEFAULT_CORRECTIONS;
		entries = HashMap.set(entries, subagent.name, { subagent, typed, corrections });
	}
	const declared: Declared = { config, entries };
	return declared;
});

/** The limits a refusal reports: whole numbers of 0 or more, checked when the subagents are declared. */
const decodeLimits = Schema.decodeUnknownEffect(Schema.Struct({ maxDepth: Count, maxLive: Count }));

/** The compiled result schema of `subagent`; none for one whose result is its answer's text. */
function typedOf(subagent: Subagent): Effect.Effect<Option.Option<Result.Typed>, SchemaConversionError> {
	return subagent.result === undefined ? Effect.succeedNone : Effect.asSome(Result.compile(subagent, subagent.result));
}

/** The declaration named `name`; fails with the names there are, in declaration order, for the parent's model. */
export function find(declared: Declared, name: Name): Effect.Effect<Entry, UnknownSubagent> {
	const entry = HashMap.get(declared.entries, name);
	if (Option.isSome(entry)) return Effect.succeed(entry.value);
	const names = Arr.map(declared.config.subagents, (subagent) => subagent.name);
	return Effect.fail(UnknownSubagent.make({ subagent: name, declared: names }));
}
