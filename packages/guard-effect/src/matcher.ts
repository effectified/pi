// Tool name matchers: the data form a policy names tools in, and how a tool's name is matched against it.

import { Schema } from "effect";

/**
 * One way to name tools, as data:
 *
 * - `Exact`: the tool with this name, compared as it is.
 * - `Prefix`: every tool whose name starts with these characters, compared as they are.
 * - `Word`: every tool whose name, split into words (see `words`), has one of `words` as its first word, or as any
 *   word. Compared in lower case.
 */
export const Matcher = Schema.Union([
	Schema.TaggedStruct("Exact", { name: Schema.String }),
	Schema.TaggedStruct("Prefix", { prefix: Schema.String }),
	Schema.TaggedStruct("Word", {
		words: Schema.Array(Schema.String),
		position: Schema.Literals(["first", "any"]),
	}),
]);

/** One way to name tools. */
export type Matcher = typeof Matcher.Type;

/** The tool called exactly `name`. */
export function exact(name: string): Matcher {
	return { _tag: "Exact", name };
}

/** Every tool whose name starts with `start`, character for character. */
export function prefix(start: string): Matcher {
	return { _tag: "Prefix", prefix: start };
}

/** Every tool whose first word is one of `verbs`: `approve` matches `approve_claim`, `approveClaim` and `approve`. */
export function firstWord(verbs: ReadonlyArray<string>): Matcher {
	return { _tag: "Word", words: verbs, position: "first" };
}

/** Every tool that has one of `terms` as a word anywhere in its name: `delete` also matches `bulk_delete`. */
export function anyWord(terms: ReadonlyArray<string>): Matcher {
	return { _tag: "Word", words: terms, position: "any" };
}

// A run of capitals that no lower-case letter follows (an acronym), a word with at most one leading capital, or a run
// of digits. Everything else separates words.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/**
 * The words of a tool name, in lower case: `sign_document`, `signDocument` and `sign-document` are `sign`, `document`;
 * `exportPDF` is `export`, `pdf`; `send2` is `send`, `2`. Only ASCII letters and digits make words.
 */
export function words(name: string): ReadonlyArray<string> {
	return (name.match(WORD) ?? []).map((word) => word.toLowerCase());
}

/** Whether `matcher` names the tool `name`. */
export function matches(matcher: Matcher, name: string): boolean {
	switch (matcher._tag) {
		case "Exact":
			return name === matcher.name;
		case "Prefix":
			return name.startsWith(matcher.prefix);
		case "Word": {
			const wanted = matcher.words.map((word) => word.toLowerCase());
			const found = words(name);
			return matcher.position === "first"
				? found[0] !== undefined && wanted.includes(found[0])
				: found.some((word) => wanted.includes(word));
		}
	}
}

/** A matcher in a few words, for an error message. */
export function describe(matcher: Matcher): string {
	switch (matcher._tag) {
		case "Exact":
			return `the name ${matcher.name}`;
		case "Prefix":
			return `the prefix ${matcher.prefix}`;
		case "Word":
			return `${matcher.position === "first" ? "the first word" : "a word"} ${matcher.words.join(", ")}`;
	}
}
