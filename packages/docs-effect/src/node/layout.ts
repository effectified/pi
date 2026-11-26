// The shell every page shares: the head, the bar across the top, the rail of every page, and the stylesheet written
// into the page, so that a page opens from a file with nothing beside it.

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_MEANING, KINDS } from "../content.ts";
import type { Facts } from "./facts.ts";
import { safe } from "./markdown.ts";
import type { Skill } from "./skills.ts";

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

/** The page of a library package. */
export function packagePage(directory: string): string {
	return `packages/${directory}.html`;
}

/** The page of a skill's file: `SKILL.md` is the skill's page, a further file a page beside it. */
export function skillPage(file: string): string {
	const [, directory = "", name = ""] = /skills\/([^/]+)\/(.+)\.md$/.exec(file) ?? [];
	return name === "SKILL" ? `skills/${directory}.html` : `skills/${directory}.${name.replaceAll("/", ".")}.html`;
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
<a href="${to("index.html")}#packages">Packages</a>
<a href="${to("index.html")}#thread">A thread in a product</a>
<a href="${to("index.html")}#upstream">Keeping up with Pi</a>
<a href="${to("index.html")}#agents">For agents</a>
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

/** A page of documentation: the rail, and `article` beside it. `kind` colours what belongs to a kind of package. */
export function docPage(
	page: Page,
	article: string,
	facts: Facts,
	skills: ReadonlyArray<Skill>,
	kind: string | undefined,
): string {
	const link = (path: string, label: string) =>
		`<li><a href="${safe(hrefFrom(page.path, path))}"${path === page.path ? ' aria-current="page"' : ""}>${safe(label)}</a></li>`;
	const groups = KINDS.map((known) => {
		const members = facts.packages.filter((pkg) => pkg.kind === known);
		return `<div data-kind="${known}"><h2>${safe(KIND_MEANING[known].plural)}</h2>
<ul>
${members.map((pkg) => link(packagePage(pkg.directory), pkg.directory)).join("\n")}
</ul></div>`;
	});
	const body = `<div class="frame">
<nav class="rail" aria-label="Pages">
<ul>
${link("index.html", "Overview")}
</ul>
${groups.join("\n")}
<div><h2>Skills for agents</h2>
<ul>
${skills.map((skill) => link(skillPage(skill.path), skill.name)).join("\n")}
</ul></div>
</nav>
<article${kind === undefined ? "" : ` data-kind="${safe(kind)}"`}>
${article}
</article>
</div>`;
	return shell(page, "doc", body, facts);
}
