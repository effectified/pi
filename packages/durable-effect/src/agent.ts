// What a conversation runs with, in this package's terms: tools and extensions given as values or as names.

import type {
	AgentChange,
	ConversationCreateOptions,
	ConversationOwnership,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import { fromPiModelRef, MODEL_THINKING_LEVELS, ModelRef as ModelRefSchema, type StrictOmit } from "@effectified/pi-ai";
import { Array as Arr, Predicate, Record, Schema } from "effect";
import { ToolName } from "./tool-name.ts";

/**
 * A tool, by its name or by anything that carries it: a `Tool` of this package, one of Pi's tools in this package's
 * form (`/tools`), or Pi's own registration. Pi stores names, so the name is all a change needs.
 */
export type NamedTool = ToolName | { readonly name: ToolName } | ToolRegistration;

/**
 * An extension, by its name or by anything that carries it: an `Extension` of this package, a plain one, or Pi's own
 * object. Pi stores names, so the name is all a change needs.
 */
export type NamedExtension = string | { readonly name: string };

/** Some of the tools: exactly these, in order. */
export type ExactlyTools = ReadonlyArray<NamedTool>;

/** Some of the extensions: exactly these, in order. */
export type ExactlyExtensions = ReadonlyArray<NamedExtension>;

/**
 * A change to a conversation's stored agent (Pi's `pi.agent`): a given field replaces the stored one, `null` clears it
 * back to the host default, an absent one changes nothing. Pi's `AgentChange` field for field, so a field Pi adds is
 * one here too, with every list of tools as `NamedTool` and every list of extensions as `NamedExtension`: `extensions`
 * selects exactly these, in order, or edits the host's default selection; `tools` enables exactly these of the
 * selected extensions' tools, or all but some; `modelTools` offers the model some of the enabled tools and never widens
 * `tools`.
 */
export type Change = { readonly [K in keyof AgentChange]?: Lists<AgentChange[K]> };

/**
 * `T` with every list of Pi's tool registrations as a list of `NamedTool` and every list of its extensions as a list
 * of `NamedExtension`, at any depth.
 */
type Lists<T> = T extends readonly (infer Element)[]
	? Element extends ToolRegistration
		? ReadonlyArray<NamedTool>
		: Element extends { readonly name: string }
			? ReadonlyArray<NamedExtension>
			: T
	: T extends object
		? { readonly [K in keyof T]: Lists<T[K]> }
		: T;

/**
 * The model of a conversation's agent (`Change.model`), as a Schema for state and wires that name one: Pi's
 * `ModelRef`, the schema of `@effectified/pi-ai`.
 */
export const ModelRef = ModelRefSchema;

/** The model of a conversation's agent: its provider's id and its id within that provider. */
export type ModelRef = typeof ModelRef.Type;

/** Tools, by name. */
const ToolNames = Schema.Array(ToolName);

/** Extensions, by name. */
const ExtensionNames = Schema.Array(Schema.String);

/** A list of extensions that selects exactly these, or an edit of the selection. */
const ExtensionSelection = Schema.Union([
	ExtensionNames,
	Schema.Struct({ add: Schema.optionalKey(ExtensionNames), remove: Schema.optionalKey(ExtensionNames) }),
]);

/** A list of tools the model is offered, or an edit of that list. */
const ToolSelection = Schema.Union([
	ToolNames,
	Schema.Struct({ add: Schema.optionalKey(ToolNames), remove: Schema.optionalKey(ToolNames) }),
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
 * send to another process, and to read back as a change `configure` takes; decoding brands the tool names and the
 * model's ids. The thinking levels are pi-ai's own list.
 * The numbers are those Pi's `configure` accepts (turns 1 or more, token counts 0 or more, integers), so a decoded
 * change is never refused there. The package's conformance check holds it equal to Pi's `AgentChange` with names for
 * the lists, so a field Pi adds or changes fails to compile until this schema has it.
 */
export const ByName = Schema.Struct({
	model: Schema.optionalKey(Schema.NullOr(ModelRef)),
	thinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.Literals(MODEL_THINKING_LEVELS))),
	extensions: Schema.optionalKey(Schema.NullOr(ExtensionSelection)),
	tools: Schema.optionalKey(Schema.NullOr(Schema.Union([ToolNames, Schema.Struct({ remove: ToolNames })]))),
	modelTools: Schema.optionalKey(Schema.NullOr(ToolSelection)),
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
	const { model, extensions, tools, modelTools, ...rest } = change;
	return {
		...rest,
		// Pi's plain model name, its ids branded here.
		...(model === undefined ? {} : { model: model === null ? null : fromPiModelRef(model) }),
		...(extensions === undefined ? {} : { extensions: swap(extensions, extensionName) }),
		...(tools === undefined ? {} : { tools: swap(tools, toolName) }),
		...(modelTools === undefined ? {} : { modelTools: swap(modelTools, toolName) }),
	};
}

/** The change Pi takes for `change`. */
export function toPi(change: Change): AgentChange {
	const { extensions, tools, modelTools, ...rest } = change;
	// Pi's own types already: a field Pi adds that lists tools or extensions fails to compile here until it is converted.
	const others: StrictOmit<AgentChange, "extensions" | "tools" | "modelTools"> = rest;
	return {
		...others,
		...(extensions === undefined ? {} : { extensions: swap(extensions, carrier) }),
		...(tools === undefined ? {} : { tools: swap(tools, carrier) }),
		...(modelTools === undefined ? {} : { modelTools: swap(modelTools, carrier) }),
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
type Choice<In> = ReadonlyArray<In> | { readonly [edit: string]: ReadonlyArray<In> | undefined } | null;

/** `C` with every member of its lists as `Item`. */
type Swapped<C, Item> =
	C extends ReadonlyArray<unknown>
		? ReadonlyArray<Item>
		: C extends object
			? { readonly [K in keyof C]: Swapped<C[K], Item> }
			: C;

/**
 * `choice` in the same shape with every member as `each` makes it: a list stays a list, an edit keeps its keys (`add`,
 * `remove`, or whatever Pi names them), `null` stays `null`.
 */
function swap<In, C extends Choice<In>, Out>(choice: C, each: (item: In) => Out): Swapped<C, Out> {
	const given: Choice<In> = choice;
	const swapped =
		given === null
			? null
			: isList(given)
				? Arr.map(given, each)
				: Record.map(given, (list) => (list === undefined ? undefined : Arr.map(list, each)));
	// The walk keeps the shape of `C` and changes only the members, which TypeScript cannot follow through a generic.
	return swapped as Swapped<C, Out>;
}

/** Whether `choice` is a list, not an edit. A change is plain data from the caller: its lists are arrays. */
function isList<In>(choice: Exclude<Choice<In>, null>): choice is ReadonlyArray<In> {
	return Arr.isArray(choice);
}

/** The name of a tool, branded: Pi's own registration names it with a plain string. */
function toolName(item: NamedTool): ToolName {
	return Predicate.isString(item) ? item : ToolName.make(item.name);
}

/** The name of an extension. */
function extensionName(item: NamedExtension): string {
	return Predicate.isString(item) ? item : item.name;
}

/** `item` as what carries its name, as Pi's lists hold it. */
function carrier(item: NamedTool | NamedExtension): { readonly name: string } {
	return Predicate.isString(item) ? { name: item } : item;
}
