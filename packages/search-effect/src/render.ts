// The compact text a model reads for a retrieval: titles, addresses, snippets, page text cut to a limit. The
// whole response is not here; it is in the result's details, which the model never reads.

import type { Hit, Retrieval, Unfetched } from "./provider/index.ts";

/** A search as a numbered list: title, address, date and author when given, and a one-line snippet. */
export function searchText(retrieval: Retrieval, snippetCharacters: number): string {
	if (retrieval.hits.length === 0) return "No results.";
	return retrieval.hits
		.map((hit, index) => {
			const excerpt = oneLine(hit.snippet ?? hit.text ?? "");
			const lines = [
				`${index + 1}. ${hit.title ?? "(no title)"}`,
				hit.url,
				byline(hit),
				excerpt.length > snippetCharacters ? `${cut(excerpt, snippetCharacters)}...` : excerpt,
			];
			return lines.filter((line) => line !== "").join("\n   ");
		})
		.join("\n\n");
}

/**
 * Fetched pages, one after the other: a heading, the address, then the text, cut to `maxCharacters` with a note
 * saying so. Pages that were not read are listed last, each with its reason.
 */
export function fetchText(retrieval: Retrieval, maxCharacters: number, skipped: ReadonlyArray<Unfetched>): string {
	const pages = retrieval.hits.map((hit) => {
		const text = hit.text ?? hit.snippet ?? "";
		const head = [`# ${hit.title ?? "(no title)"}`, hit.url, byline(hit)].filter((line) => line !== "");
		// A provider cuts at the length it was asked for, so text of exactly that length was most likely cut too.
		const note = text.length >= maxCharacters ? [`[Cut at ${maxCharacters} characters.]`] : [];
		return [head.join("\n"), text === "" ? "(no text)" : cut(text, maxCharacters), ...note].join("\n\n");
	});
	const missing = [...retrieval.unfetched, ...skipped].map(({ url, reason }) => `Not fetched: ${url} (${reason})`);
	return [...pages, ...(missing.length === 0 ? [] : [missing.join("\n")])].join("\n\n---\n\n");
}

/** When and by whom a page was published, as far as the provider said. */
function byline(hit: Hit): string {
	return [hit.publishedDate, hit.author].filter((part) => part !== undefined).join(" · ");
}

/** `text` with every run of white space as one space. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The first `length` UTF-16 units of `text`, one fewer when that would split a character in two. */
function cut(text: string, length: number): string {
	if (text.length <= length) return text;
	const last = text.charCodeAt(length - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}
