// Builds the site from the documentation as Pi keeps its own (`docs/` and its catalog `docs.json`): the landing
// page, each page of the catalog, each package's README as a page, and `llms.txt`. Nothing built is committed: `dist`
// is made from the tree, so it cannot name what the tree does not.
// Usage: node src/node/build.ts [directory]   (the directory defaults to this package's `dist`)

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Catalog, catalogProblems, readCatalog, readPages } from "./catalog.ts";
import { DOCS, documentProblems } from "./contract.ts";
import { type Facts, HERE, ROOT, read } from "./facts.ts";
import { landing } from "./landing.ts";
import { docPage, docsPage, hrefFrom, packagePage } from "./layout.ts";
import { codeBlocks, type Heading, render, safe } from "./markdown.ts";
import { problems, readSkills, type Skill } from "./skills.ts";

/** What the site is built from. */
export interface Sources {
	readonly facts: Facts;
	readonly catalog: Catalog;
	/** The Markdown pages of the documentation's directory, by their path from it. */
	readonly pages: ReadonlyMap<string, string>;
	readonly skills: ReadonlyArray<Skill>;
}

/** The sources as the tree has them. */
export function sources(): Sources {
	return { facts: read(), catalog: readCatalog(), pages: readPages(), skills: readSkills() };
}

/** What the sources break: the catalog's rules, and the contract of every page and every skill. */
export function broken({ facts, catalog, pages, skills }: Sources): string[] {
	return [
		...catalogProblems(catalog, pages),
		...[...pages.keys()].flatMap((path) => documentProblems(`${DOCS}/${path}`, facts)),
		...skills.flatMap((skill) => problems(skill, facts)),
	];
}

/** Every file of the site by its path from the site's root. Throws when a source breaks its rules. */
export function site(from: Sources = sources()): ReadonlyMap<string, string> {
	const { facts, catalog, pages, skills } = from;
	const found = broken(from);
	if (found.length > 0) throw new Error(`The documentation breaks its rules:\n  ${found.join("\n  ")}`);
	const composition = facts.packages.find((pkg) => pkg.kind === "composition");
	if (composition === undefined)
		throw new Error("no composition among the packages: the landing page shows its example");
	const files = new Map<string, string>();
	files.set("index.html", landing(facts, skills, example(composition.readme, "The composition")));
	for (const { path, title } of catalog.pages) {
		const out = docsPage(path);
		const rendered = render(pages.get(path) ?? "", linker(from, `${DOCS}/${path}`, out));
		const article = withContents(rendered.html, rendered.headings);
		const description = `${title}, in the documentation of pi-effect.`;
		files.set(
			out,
			docPage({ path: out, title: `${title} | pi-effect`, description }, article, facts, catalog, undefined),
		);
	}
	for (const pkg of facts.packages) {
		const out = packagePage(pkg.directory);
		const rendered = render(pkg.readme, linker(from, `packages/${pkg.directory}/README.md`, out));
		const kind = `${pkg.kind.charAt(0).toUpperCase()}${pkg.kind.slice(1)}`;
		const article = `<p class="kind">${safe(kind)}</p>\n${withContents(rendered.html, rendered.headings)}`;
		files.set(
			out,
			docPage({ path: out, title: pkg.name, description: pkg.description }, article, facts, catalog, pkg.kind),
		);
	}
	files.set("llms.txt", llms(from));
	return files;
}

/** Writes the site into `directory` and returns the paths written, from that directory. */
export function build(directory: string = join(HERE, "dist")): string[] {
	const files = site();
	for (const [path, content] of files) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	return [...files.keys()];
}

/**
 * Where a link of the document `source` leads on the site, written for the page `page`. A page of the catalog is
 * its page, a package's directory or README that package's page; any other file of the repository is its address on
 * the repository's host, since the site holds no copy of it.
 */
function linker({ facts, pages }: Sources, source: string, page: string): (href: string) => string {
	return (href) => {
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
		const [path = "", anchor] = href.split("#");
		const suffix = anchor === undefined ? "" : `#${anchor}`;
		const target = normalize(join(dirname(source), path)).replace(/\/$/, "");
		if (target.startsWith(`${DOCS}/`) && pages.has(target.slice(DOCS.length + 1))) {
			return `${hrefFrom(page, docsPage(target.slice(DOCS.length + 1)))}${suffix}`;
		}
		const pkg = facts.packages.find(
			(found) => target === `packages/${found.directory}` || target === `packages/${found.directory}/README.md`,
		);
		if (pkg !== undefined) return `${hrefFrom(page, packagePage(pkg.directory))}${suffix}`;
		const absolute = join(ROOT, target);
		const view = existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob";
		return `${facts.repository}/${view}/${facts.branch}/${target}${suffix}`;
	};
}

/** A rendered document with a list of its sections after its title, when it has several. */
function withContents(html: string, headings: ReadonlyArray<Heading>): string {
	const sections = headings.filter((heading) => heading.depth === 2);
	const end = html.indexOf("</h1>");
	if (sections.length < 4 || end === -1) return html;
	const list = sections.map((heading) => `<li><a href="#${safe(heading.id)}">${safe(heading.text)}</a></li>`);
	const contents = `<details class="contents"><summary>On this page</summary>\n<ul>\n${list.join("\n")}\n</ul></details>`;
	return `${html.slice(0, end + "</h1>".length)}\n${contents}${html.slice(end + "</h1>".length)}`;
}

/** The first TypeScript example under a second-level heading of a README. */
function example(readme: string, heading: string): string {
	const at = readme.indexOf(`\n## ${heading}\n`);
	const block = at === -1 ? undefined : codeBlocks(readme.slice(at)).find((found) => found.lang === "ts");
	if (block === undefined) throw new Error(`the composition's README has no TypeScript example under "## ${heading}"`);
	return block.lines.join("\n");
}

/**
 * The index an agent reads before anything else (the `llms.txt` convention): every page, every package and every
 * skill, one line each, with a link to its Markdown. The links are relative to the built site, and hold where the
 * packages are vendored beside it.
 */
function llms({ facts, catalog, skills }: Sources): string {
	const from = "packages/docs-effect/dist/llms.txt";
	const lines = [
		"# pi-effect",
		"",
		`> ${facts.packages.length} packages that put Pi's durable agent harness into Effect ${facts.effect.replace(/^~/, "")}, with guards, budgets, model routing, records, review, approvals, subagents and swarms, composed into one agent thread that runs in one process or as a Rivet actor. For Pi ${facts.pi}. The pages below say which package and export to use, the order that must not change, and what is not guaranteed. Each package's README is its reference, and its examples are run by the package's tests.`,
		"",
		"## Documentation",
		"",
		...catalog.pages.map((page) => `- [${page.title}](${hrefFrom(from, `${DOCS}/${page.path}`)})`),
		"",
		"## Packages",
		"",
		...facts.packages.map(
			(pkg) =>
				`- [${pkg.name}](${hrefFrom(from, `packages/${pkg.directory}/README.md`)}) (${pkg.kind}): ${pkg.description}`,
		),
		"",
		"## Skills",
		"",
		...skills.map((skill) => `- [${skill.name}](${hrefFrom(from, skill.path)}): ${skill.description}`),
		"",
	];
	return lines.join("\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = resolve(process.argv[2] ?? join(HERE, "dist"));
	const written = build(directory);
	console.log(`docs: wrote ${written.length} files into ${directory}. Open ${join(directory, "index.html")}.`);
}
