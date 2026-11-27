// Tool name matchers: the data form a policy names tools in, and how a tool's name is matched against it.

import { ToolName } from "@effectified/pi-durable";
import { Array as Arr, Option, pipe, Schema, String as Str } from "effect";
import { dual } from "effect/Function";

/**
 * One way to name tools, as data:
 *
 * - `Exact`: the tool with this name, compared as it is.
 * - `Prefix`: every tool whose name starts with these characters, compared as they are.
 * - `Word`: every tool whose name, split into words (see `words`), has one of `words` as its first word, or as any
 *   word. Compared in lower case.
 *
 * Choose with `Matcher.match`.
 */
export const Matcher = Schema.TaggedUnion({
	Exact: { name: ToolName },
	Prefix: { prefix: Schema.String },
	Word: { words: Schema.Array(Schema.String), position: Schema.Literals(["first", "any"]) },
});

/** One way to name tools. */
export type Matcher = typeof Matcher.Type;

/** The tool called exactly `name`. */
export function exact(name: ToolName): Matcher {
	return Matcher.cases.Exact.make({ name });
}

/** Every tool whose name starts with `start`, character for character. */
export function prefix(start: string): Matcher {
	return Matcher.cases.Prefix.make({ prefix: start });
}

/** Every tool whose first word is one of `verbs`: `approve` matches `approve_claim`, `approveClaim` and `approve`. */
export function firstWord(verbs: ReadonlyArray<string>): Matcher {
	return Matcher.cases.Word.make({ words: verbs, position: "first" });
}

/** Every tool that has one of `terms` as a word anywhere in its name: `delete` also matches `bulk_delete`. */
export function anyWord(terms: ReadonlyArray<string>): Matcher {
	return Matcher.cases.Word.make({ words: terms, position: "any" });
}

// A run of capitals that no lower-case letter follows (an acronym), a word with at most one leading capital, or a run
// of digits. Everything else separates words.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/**
 * The words of a tool name, in lower case: `sign_document`, `signDocument` and `sign-document` are `sign`, `document`;
 * `exportPDF` is `export`, `pdf`; `send2` is `send`, `2`. Only ASCII letters and digits make words.
 */
export function words(name: string): ReadonlyArray<string> {
	return pipe(
		name,
		Str.match(WORD),
		Option.match({ onNone: () => [], onSome: (found) => Arr.map(found, Str.toLowerCase) }),
	);
}

/** Whether `matcher` names the tool `name`. Data-first, or data-last on the matcher. */
export const matches: {
	(name: string): (matcher: Matcher) => boolean;
	(matcher: Matcher, name: string): boolean;
} = dual(2, (matcher: Matcher, name: string): boolean =>
	Matcher.match(matcher, {
		Exact: (exact) => name === exact.name,
		Prefix: (start) => pipe(name, Str.startsWith(start.prefix)),
		Word: ({ words: wanted, position }) => {
			const lower = Arr.map(wanted, Str.toLowerCase);
			const found = words(name);
			return position === "first"
				? Option.exists(Arr.head(found), (first) => Arr.contains(lower, first))
				: Arr.some(found, (word) => Arr.contains(lower, word));
		},
	}),
);

/** A matcher in a few words, for an error message. */
export function describe(matcher: Matcher): string {
	return Matcher.match(matcher, {
		Exact: ({ name }) => `the name ${name}`,
		Prefix: (start) => `the prefix ${start.prefix}`,
		Word: ({ words: listed, position }) =>
			`${position === "first" ? "the first word" : "a word"} ${Arr.join(listed, ", ")}`,
	});
}
