// The shell every page shares: the head, the bar across the top, the rail of every page, and the stylesheet written
// into the page, so that a page opens from a file with nothing beside it.

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_MEANING, KINDS } from "../content.ts";
import type { Catalog, Item } from "./catalog.ts";
import type { Facts } from "./facts.ts";
import { safe } from "./markdown.ts";

/** What a page is, apart from its content. */
export interface Page {
	/** Where it is written, from the site's root: `packages/thread-effect.html`. */
	readonly path: string;
	readonly title: string;
	readonly description: string;
}

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../site.css"), "utf8");

/** The address of the page `to` as written on the page `from`, both from the site's root. */
export function hrefFrom(from: string, to: string): string {
	return relative(dirname(from), to).split("\\").join("/");
}

/** The page of a library package's README. */
export function packagePage(directory: string): string {
	return `packages/${directory}.html`;
}

/** The page of a page of the documentation, by its path in the catalog: `threads.md` is `docs/threads.html`. */
export function docsPage(path: string): string {
	return `docs/${path.slice(0, -".md".length)}.html`;
}

/** A whole HTML document: `body` between the bar and the foot. */
export function shell(page: Page, kind: "landing" | "doc", body: string, facts: Facts): string {
	const to = (path: string) => safe(hrefFrom(page.path, path));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe(page.title)}</title>
<meta name="description" content="${safe(page.description)}">
<meta name="color-scheme" content="light dark">
<style>
${CSS}</style>
</head>
<body class="${kind}">
<header class="top">
<a class="mark" href="${to("index.html")}">pi-effect</a>
<nav aria-label="Site">
<a href="${to(docsPage("index.md"))}">Documentation</a>
<a href="${to(docsPage("quickstart.md"))}">Quickstart</a>
<a href="${to(docsPage("packages.md"))}">Packages</a>
<a href="${to(docsPage("agents.md"))}">For agents</a>
<a href="${safe(facts.repository)}/tree/${safe(facts.branch)}">Source</a>
</nav>
</header>
${body}
<footer>
<p>pi-effect ${safe(facts.version)}, for Pi ${safe(facts.pi)}, effect ${safe(facts.effect)} and rivetkit ${safe(facts.rivetkit)}. Node ${safe(facts.node)} or newer, or Bun. MIT. Every test runs on scripted models and, for the Rivet host, on a real local engine. No real model provider has been run yet.</p>
</footer>
</body>
</html>
`;
}

/**
 * A page beside the rail: the catalog's navigation as it is written, then every package's README by kind. `kind`
 * colours what belongs to a kind of package.
 */
export function docPage(page: Page, article: string, facts: Facts, catalog: Catalog, kind: string | undefined): string {
	const link = (path: string, label: string) =>
		`<a href="${safe(hrefFrom(page.path, path))}"${path === page.path ? ' aria-current="page"' : ""}>${safe(label)}</a>`;
	const entries = (items: ReadonlyArray<Item>): string =>
		`<ul>\n${items
			.map((item) => {
				const head =
					item.path === undefined ? `<span>${safe(item.title)}</span>` : link(docsPage(item.path), item.title);
				return `<li>${head}${item.items.length === 0 ? "" : `\n${entries(item.items)}`}</li>`;
			})
			.join("\n")}\n</ul>`;
	const navigation = catalog.groups.map(
		(group) => `<div><h2>${safe(group.title)}</h2>\n${entries(group.items)}</div>`,
	);
	const readmes = KINDS.map((known) => {
		const members = facts.packages.filter((pkg) => pkg.kind === known);
		return `<div class="readmes" data-kind="${known}"><h2>${safe(KIND_MEANING[known].plural)}</h2>
<ul>
${members.map((pkg) => `<li>${link(packagePage(pkg.directory), pkg.directory)}</li>`).join("\n")}
</ul></div>`;
	});
	const body = `<div class="frame">
<nav class="rail" aria-label="Pages">
${navigation.join("\n")}
${readmes.join("\n")}
</nav>
<article${kind === undefined ? "" : ` data-kind="${safe(kind)}"`}>
${article}
</article>
</div>`;
	return shell(page, "doc", body, facts);
}
