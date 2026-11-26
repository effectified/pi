// Markdown to the HTML of a page: headings get the ids GitHub gives them, so a README's own anchors keep working,
// and every link goes through the caller, which knows where its target is on the site.

import { Marked } from "marked";

/** A heading of a rendered document. */
export interface Heading {
	readonly depth: number;
	readonly id: string;
	/** Its text without markup. */
	readonly text: string;
}

/** A rendered document. */
export interface Rendered {
	readonly html: string;
	readonly headings: ReadonlyArray<Heading>;
}

/**
 * Renders GitHub-flavoured Markdown. `link` gives the address to write for each link's target as the document has
 * it. Raw HTML in the document is kept as it is: the documents are this repository's own.
 */
export function render(markdown: string, link: (href: string) => string = (href) => href): Rendered {
	const headings: Heading[] = [];
	const slug = slugger();
	const marked = new Marked({ gfm: true, async: false });
	marked.use({
		renderer: {
			heading({ tokens, depth }) {
				const inner = this.parser.parseInline(tokens);
				const text = plain(inner);
				const id = slug(text);
				headings.push({ depth, id, text });
				return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const attributes = title === null || title === undefined ? "" : ` title="${safe(title)}"`;
				return `<a href="${safe(link(href))}"${attributes}>${this.parser.parseInline(tokens)}</a>`;
			},
			code({ text, lang }) {
				const language = (lang ?? "").split(/\s/)[0] ?? "";
				const attribute = language === "" ? "" : ` class="language-${safe(language)}"`;
				return `<pre><code${attribute}>${safe(text)}</code></pre>\n`;
			},
		},
	});
	const html = marked
		.parse(markdown, { async: false })
		// A wide table scrolls inside its own box, and the page does not.
		.replaceAll("<table>", '<div class="table"><table>')
		.replaceAll("</table>", "</table></div>");
	return { html, headings };
}

/** The fenced code blocks of a document, each with its language and its lines. */
export function codeBlocks(markdown: string): Array<{ readonly lang: string; readonly lines: ReadonlyArray<string> }> {
	const blocks: Array<{ lang: string; lines: string[] }> = [];
	let open: { lang: string; lines: string[]; fence: string } | undefined;
	for (const line of markdown.split("\n")) {
		const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
		if (open === undefined) {
			if (fence !== null) open = { lang: fence[2] ?? "", lines: [], fence: fence[1] ?? "```" };
		} else if (fence !== null && line.trim() === open.fence) {
			blocks.push({ lang: open.lang, lines: open.lines });
			open = undefined;
		} else open.lines.push(line);
	}
	return blocks;
}

/** A document without its fenced code blocks: what is prose, for a reader of its links and names. */
export function prose(markdown: string): string {
	const kept: string[] = [];
	let fence: string | undefined;
	for (const line of markdown.split("\n")) {
		const found = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === undefined) {
			if (found === undefined) kept.push(line);
			else fence = found;
		} else if (line.trim() === fence) fence = undefined;
	}
	return kept.join("\n");
}

/** Text as HTML text or an attribute value. */
export function safe(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Gives each heading text its id as GitHub does: lower case, punctuation dropped, each space a hyphen, and a number
 * appended to a text that came before.
 */
function slugger(): (text: string) => string {
	const seen = new Map<string, number>();
	return (text) => {
		const base = text
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

/** The text of rendered inline HTML. */
function plain(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}
