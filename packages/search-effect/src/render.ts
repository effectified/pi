// The compact text a model reads for a retrieval: titles, addresses, snippets, page text cut to a limit. The
// whole response is not here; it is in the result's details, which the model never reads.

import { Array as Arr, Option, pipe, String as Str } from "effect";
import type { Hit, Retrieval, Unfetched } from "./provider/index.ts";

/** A search as a numbered list: title, address, date and author when given, and a one-line snippet. */
export function searchText(retrieval: Retrieval, snippetCharacters: number): string {
	if (Arr.isReadonlyArrayEmpty(retrieval.hits)) return "No results.";
	const entries = Arr.map(retrieval.hits, (hit, index) => {
		const excerpt = oneLine(hit.snippet ?? hit.text ?? "");
		const lines = [
			`${index + 1}. ${hit.title ?? "(no title)"}`,
			hit.url,
			byline(hit),
			excerpt.length > snippetCharacters ? `${cut(excerpt, snippetCharacters)}...` : excerpt,
		];
		return Arr.join(Arr.filter(lines, Str.isNonEmpty), "\n   ");
	});
	return Arr.join(entries, "\n\n");
}

/**
 * Fetched pages, one after the other: a heading, the address, then the text, cut to `maxCharacters` with a note
 * saying so. Pages that were not read are listed last, each with its reason.
 */
export function fetchText(retrieval: Retrieval, maxCharacters: number, skipped: ReadonlyArray<Unfetched>): string {
	const pages = Arr.map(retrieval.hits, (hit) => {
		const text = hit.text ?? hit.snippet ?? "";
		const head = Arr.filter([`# ${hit.title ?? "(no title)"}`, hit.url, byline(hit)], Str.isNonEmpty);
		// A provider cuts at the length it was asked for, so text of exactly that length was most likely cut too.
		const note = text.length >= maxCharacters ? [`[Cut at ${maxCharacters} characters.]`] : [];
		return Arr.join([Arr.join(head, "\n"), text === "" ? "(no text)" : cut(text, maxCharacters), ...note], "\n\n");
	});
	const missing = Arr.map(
		[...retrieval.unfetched, ...skipped],
		({ url, reason }) => `Not fetched: ${url} (${reason})`,
	);
	const sections = Arr.isReadonlyArrayEmpty(missing) ? pages : Arr.append(pages, Arr.join(missing, "\n"));
	return Arr.join(sections, "\n\n---\n\n");
}

/** When and by whom a page was published, as far as the provider said. */
function byline(hit: Hit): string {
	return Arr.join(
		Arr.filter([hit.publishedDate, hit.author], (part) => part !== undefined),
		" · ",
	);
}

/** `text` with every run of white space as one space. */
function oneLine(text: string): string {
	return pipe(text, Str.replace(/\s+/g, " "), Str.trim);
}

/** The first `length` UTF-16 units of `text`, one fewer when that would split a character in two. */
function cut(text: string, length: number): string {
	if (text.length <= length) return text;
	const highSurrogate = pipe(
		Str.charCodeAt(text, length - 1),
		Option.exists((unit) => unit >= 0xd800 && unit <= 0xdbff),
	);
	return pipe(text, Str.slice(0, highSurrogate ? length - 1 : length));
}
