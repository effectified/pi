// What a conversation runs with, in this package's terms: tools and extensions given as values or as names.

import type { AgentChange, ConversationCreateOptions, ConversationOwnership } from "@earendil-works/pi-durable";

/**
 * A tool or an extension, by its name or by anything that carries it: a `Tool` or an `Extension` of this package, or
 * Pi's own object. Pi stores names, so the name is all a change needs.
 */
export type Named = string | { readonly name: string };

/** Some of a list: exactly these, in order. */
export type Exactly = ReadonlyArray<Named>;

/**
 * A change to a conversation's stored agent (Pi's `pi.agent`): a given field replaces the stored one, `null` clears it
 * back to the host default, an absent one changes nothing. Pi's `AgentChange`, with tools and extensions as `Named`.
 */
export interface Change extends Omit<AgentChange, "extensions" | "tools" | "modelTools"> {
	/** A list selects exactly these extensions, in order; an object edits the host's default selection. */
	readonly extensions?: Exactly | { readonly add?: Exactly; readonly remove?: Exactly } | null;
	/** Of the selected extensions' tools, the enabled ones: a list enables exactly these, in order. */
	readonly tools?: Exactly | { readonly remove: Exactly } | null;
	/** Of the enabled tools, those the model is offered; other tools may still call the rest. Never widens `tools`. */
	readonly modelTools?: Exactly | { readonly remove?: Exactly; readonly add?: Exactly } | null;
}

/** The change Pi takes for `change`. */
export function toPi(change: Change): AgentChange {
	const { extensions, tools, modelTools, ...rest } = change;
	return {
		...rest,
		...(extensions === undefined ? {} : { extensions: selection(extensions) }),
		...(tools === undefined ? {} : { tools: selection(tools) }),
		...(modelTools === undefined ? {} : { modelTools: selection(modelTools) }),
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

/** A list, or an edit of lists, with every member as an object that carries its name. */
function selection(
	choice: Exactly | { readonly add?: Exactly; readonly remove?: Exactly } | null,
): ReadonlyArray<{ readonly name: string }> | { readonly add?: unknown; readonly remove?: unknown } | null {
	if (choice === null) return null;
	if (isList(choice)) return choice.map(named);
	return {
		...(choice.add === undefined ? {} : { add: choice.add.map(named) }),
		...(choice.remove === undefined ? {} : { remove: choice.remove.map(named) }),
	};
}

function isList(choice: Exactly | object): choice is Exactly {
	return Array.isArray(choice);
}

function named(item: Named): { readonly name: string } {
	return typeof item === "string" ? { name: item } : item;
}
