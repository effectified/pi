// A fork's answer as JSON: where the JSON value sits in the text a model wrote, and the words that ask for it.

import { Array as Arr, Option, pipe, Schema, String as Str } from "effect";

/**
 * The JSON value a model's answer holds: the whole text, else the last fenced block that parses, else the text from
 * its first brace to its last, else from its first bracket to its last. None when nothing of it is JSON.
 */
export function jsonOf(text: string): Option.Option<unknown> {
	const fenced = Arr.reverse(Arr.map(Arr.fromIterable(pipe(text, Str.matchAll(FENCED))), (match) => match[1] ?? ""));
	const candidates = [text, ...fenced, between(text, "{", "}"), between(text, "[", "]")];
	return Option.firstSomeOf(Arr.map(candidates, (candidate) => parse(Str.trim(candidate))));
}

// A fenced block of Markdown, with or without a language after the opening fence.
const FENCED = /```[^\n`]*\n([\s\S]*?)```/g;

const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The text from the first `open` to the last `close`, both included; empty when they are not there in that order. */
function between(text: string, open: string, close: string): string {
	const span = Option.all([pipe(text, Str.indexOf(open)), pipe(text, Str.lastIndexOf(close))]);
	return Option.match(
		Option.filter(span, ([start, end]) => end >= start),
		{ onNone: () => "", onSome: ([start, end]) => pipe(text, Str.slice(start, end + 1)) },
	);
}

/** What a job's prompt ends with: how the fork must answer. `jsonSchema` is the result's JSON Schema, when it has one. */
export function instruction(jsonSchema: Option.Option<string>): string {
	const shape = Option.match(jsonSchema, {
		onNone: () => "",
		onSome: (schema) => ` It must match this JSON Schema:\n${schema}`,
	});
	return `Answer with one JSON value and nothing else: no prose and no code fence.${shape}`;
}

/** What a fork is told when its answer was not the JSON asked for: what was wrong, and to answer again. */
export function correction(issues: string): string {
	return `Your last answer was not accepted:\n${issues}\nAnswer again with one corrected JSON value and nothing else.`;
}
