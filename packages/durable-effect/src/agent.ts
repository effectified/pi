// What a conversation runs with, in this package's terms: tools and extensions given as values or as names.

import type { AgentChange, ConversationCreateOptions, ConversationOwnership } from "@earendil-works/pi-durable";
import { MODEL_THINKING_LEVELS, ModelRef as ModelRefSchema, type StrictOmit } from "@effectified/pi-ai";
import { Schema } from "effect";

/**
 * A tool or an extension, by its name or by anything that carries it: a `Tool` or an `Extension` of this package, or
 * Pi's own object. Pi stores names, so the name is all a change needs.
 */
export type Named = string | { readonly name: string };

/** Some of a list: exactly these, in order. */
export type Exactly = ReadonlyArray<Named>;

/**
 * A change to a conversation's stored agent (Pi's `pi.agent`): a given field replaces the stored one, `null` clears it
 * back to the host default, an absent one changes nothing. Pi's `AgentChange` field for field, so a field Pi adds is
 * one here too, with every list of tools or extensions as `Named`: `extensions` selects exactly these, in order, or
 * edits the host's default selection; `tools` enables exactly these of the selected extensions' tools, or all but
 * some; `modelTools` offers the model some of the enabled tools and never widens `tools`.
 */
export type Change = { readonly [K in keyof AgentChange]?: Lists<AgentChange[K], Named> };

/** `T` with every list of named Pi objects (extensions, tool registrations) as a list of `Item`, at any depth. */
type Lists<T, Item> = T extends readonly (infer Element)[]
	? Element extends { readonly name: string }
		? ReadonlyArray<Item>
		: T
	: T extends object
		? { readonly [K in keyof T]: Lists<T[K], Item> }
		: T;

/**
 * The model of a conversation's agent (`Change.model`), as a Schema for state and wires that name one: Pi's
 * `ModelRef`, the schema of `@effectified/pi-ai`.
 */
export const ModelRef = ModelRefSchema;

/** The model of a conversation's agent: its provider's id and its id within that provider. */
export type ModelRef = typeof ModelRef.Type;

/** Tools or extensions, by name. */
const Names = Schema.Array(Schema.String);

/** A list that selects exactly these, or an edit of a selection. */
const Selection = Schema.Union([
	Names,
	Schema.Struct({ add: Schema.optionalKey(Names), remove: Schema.optionalKey(Names) }),
]);

/** A token count of compaction settings: what Pi's `configure` takes, an integer 0 or more. */
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Compaction thresholds, each optional: Pi's `Partial<CompactionPolicy>`. */
const Policy = Schema.Struct({
	enabled: Schema.optionalKey(Schema.Boolean),
	reserveTokens: Schema.optionalKey(Tokens),
	keepRecentTokens: Schema.optionalKey(Tokens),
	backgroundTokens: Schema.optionalKey(Tokens),
});

/**
 * A `Change` as plain JSON, every tool and extension by its name (what `byName` makes), to keep in stored state or
 * send to another process, and to read back as a change `configure` takes. The thinking levels are pi-ai's own list.
 * The numbers are those Pi's `configure` accepts (turns 1 or more, token counts 0 or more, integers), so a decoded
 * change is never refused there. The package's conformance check holds it equal to Pi's `AgentChange` with names for
 * the lists, so a field Pi adds or changes fails to compile until this schema has it.
 */
export const ByName = Schema.Struct({
	model: Schema.optionalKey(Schema.NullOr(ModelRef)),
	thinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.Literals(MODEL_THINKING_LEVELS))),
	extensions: Schema.optionalKey(Schema.NullOr(Selection)),
	tools: Schema.optionalKey(Schema.NullOr(Schema.Union([Names, Schema.Struct({ remove: Names })]))),
	modelTools: Schema.optionalKey(Schema.NullOr(Selection)),
	instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
	cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
	maxTurns: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
	compaction: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({ ...Policy.fields, modelOverrides: Schema.optionalKey(Schema.Record(Schema.String, Policy)) }),
		),
	),
});

/** A `Change` as plain JSON, every tool and extension by its name. */
export type ByName = typeof ByName.Type;

/** `change` with every tool and extension as its name: its JSON form, `ByName`. Nothing is checked. */
export function byName(change: Change): ByName {
	const { extensions, tools, modelTools, ...rest } = change;
	return {
		...rest,
		...(extensions === undefined ? {} : { extensions: selection(extensions, nameOf) }),
		...(tools === undefined ? {} : { tools: selection(tools, nameOf) }),
		...(modelTools === undefined ? {} : { modelTools: selection(modelTools, nameOf) }),
	};
}

/** The change Pi takes for `change`. */
export function toPi(change: Change): AgentChange {
	const { extensions, tools, modelTools, ...rest } = change;
	// Pi's own types already: a field Pi adds that lists tools or extensions fails to compile here until it is converted.
	const others: StrictOmit<AgentChange, "extensions" | "tools" | "modelTools"> = rest;
	return {
		...others,
		...(extensions === undefined ? {} : { extensions: selection(extensions, carrier) }),
		...(tools === undefined ? {} : { tools: selection(tools, carrier) }),
		...(modelTools === undefined ? {} : { modelTools: selection(modelTools, carrier) }),
		// Pi's lists are typed as its own registrations and extensions, of which `configure()` reads only the name:
		// a name is the whole of what it stores.
	} as AgentChange;
}

/** Pi's options for a conversation created with `ownership` and, when given, `agent`, applied in that commit. */
export function creation(options: {
	readonly ownership: ConversationOwnership;
	readonly agent?: Change;
}): ConversationCreateOptions {
	return options.agent === undefined
		? { ownership: options.ownership }
		: { ownership: options.ownership, agent: toPi(options.agent) };
}

/** What lists tools or extensions in a change: a list, an edit whose every value is a list, or `null`. */
type Choice = Exactly | { readonly [edit: string]: Exactly | undefined } | null;

/** `C` with every member of its lists as `Item`. */
type Swapped<C, Item> = C extends ReadonlyArray<unknown>
	? ReadonlyArray<Item>
	: C extends object
		? { readonly [K in keyof C]: Swapped<C[K], Item> }
		: C;

/**
 * `choice` in the same shape with every member as `each` makes it: a list stays a list, an edit keeps its keys (`add`,
 * `remove`, or whatever Pi names them), `null` stays `null`.
 */
function selection<C extends Choice, Item>(choice: C, each: (item: Named) => Item): Swapped<C, Item> {
	const swapped =
		choice === null
			? null
			: isList(choice)
				? choice.map(each)
				: Object.fromEntries(Object.entries(choice).map(([edit, list]) => [edit, list?.map(each)]));
	// The walk keeps the shape of `C` and changes only the members, which TypeScript cannot follow through a generic.
	return swapped as Swapped<C, Item>;
}

function isList(choice: Exactly | object): choice is Exactly {
	return Array.isArray(choice);
}

function nameOf(item: Named): string {
	return typeof item === "string" ? item : item.name;
}

function carrier(item: Named): { readonly name: string } {
	return typeof item === "string" ? { name: item } : item;
}
