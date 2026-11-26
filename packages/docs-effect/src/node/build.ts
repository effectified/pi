// Builds the site: the landing page, each package's README as a page, each skill as a page, and `llms.txt`.
// Nothing built is committed: `dist` is made from the tree, so it cannot name what the tree does not.
// Usage: node src/node/build.ts [directory]   (the directory defaults to this package's `dist`)

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Facts, HERE, ROOT, read } from "./facts.ts";
import { landing } from "./landing.ts";
import { docPage, hrefFrom, packagePage, skillPage } from "./layout.ts";
import { codeBlocks, render, safe } from "./markdown.ts";
import { problems, readSkills, type Skill } from "./skills.ts";

/** Every file of the site by its path from the site's root. Throws when a skill breaks its contract. */
export function site(facts: Facts = read(), skills: ReadonlyArray<Skill> = readSkills()): ReadonlyMap<string, string> {
	const broken = skills.flatMap((skill) => problems(skill, facts));
	if (broken.length > 0) throw new Error(`The skills break their contract:\n  ${broken.join("\n  ")}`);
	const composition = facts.packages.find((pkg) => pkg.kind === "composition");
	if (composition === undefined)
		throw new Error("no composition among the packages: the landing page shows its example");
	const files = new Map<string, string>();
	files.set("index.html", landing(facts, skills, example(composition.readme, "The composition")));
	for (const pkg of facts.packages) {
		const path = packagePage(pkg.directory);
		const source = `packages/${pkg.directory}/README.md`;
		const rendered = render(pkg.readme, linker(facts, skills, source, path));
		const kind = `${pkg.kind.charAt(0).toUpperCase()}${pkg.kind.slice(1)}`;
		const article = `<p class="kind">${safe(kind)}</p>\n${withContents(rendered.html, rendered.headings)}`;
		files.set(
			path,
			docPage({ path, title: `${pkg.name}`, description: pkg.description }, article, facts, skills, pkg.kind),
		);
	}
	for (const skill of skills) {
		for (const file of skill.files) {
			const path = skillPage(file);
			const text = file === skill.path ? skill.body : readFileSync(join(ROOT, file), "utf8");
			const rendered = render(text, linker(facts, skills, file, path));
			const titled = rendered.headings[0]?.depth === 1;
			const markdown = hrefFrom(join("dist", path), file.slice("packages/docs-effect/".length));
			const article = `<p class="kind">Skill for agents</p>
${file === skill.path && !titled ? `<h1>${safe(skill.name)}</h1>\n` : ""}${
	file === skill.path
		? `<p class="about">${safe(skill.description)} <a href="${safe(markdown)}">The Markdown an agent reads</a>.</p>\n`
		: ""
}${rendered.html}`;
			files.set(
				path,
				docPage({ path, title: skill.name, description: skill.description }, article, facts, skills, undefined),
			);
		}
	}
	files.set("llms.txt", llms(facts, skills));
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
 * Where a link of the document `source` leads on the site, written for the page `page`. A package's directory or
 * README is that package's page, a skill's file its page; any other file of the repository is its address on the
 * repository's host, since the site holds no copy of it.
 */
function linker(facts: Facts, skills: ReadonlyArray<Skill>, source: string, page: string): (href: string) => string {
	return (href) => {
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href;
		const [path = "", anchor] = href.split("#");
		const suffix = anchor === undefined ? "" : `#${anchor}`;
		const target = normalize(join(dirname(source), path)).replace(/\/$/, "");
		const pkg = facts.packages.find(
			(found) => target === `packages/${found.directory}` || target === `packages/${found.directory}/README.md`,
		);
		if (pkg !== undefined) return `${hrefFrom(page, packagePage(pkg.directory))}${suffix}`;
		if (skills.some((skill) => skill.files.includes(target))) return `${hrefFrom(page, skillPage(target))}${suffix}`;
		const absolute = join(ROOT, target);
		const view = existsSync(absolute) && statSync(absolute).isDirectory() ? "tree" : "blob";
		return `${facts.repository}/${view}/${facts.branch}/${target}${suffix}`;
	};
}

/** A rendered document with a list of its sections after its title, when it has several. */
function withContents(html: string, headings: ReadonlyArray<{ depth: number; id: string; text: string }>): string {
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
 * The index an agent reads before anything else (the `llms.txt` convention): every package and every skill, one
 * line each, with a link to its Markdown. The links are relative to the built site, and hold where the packages are
 * vendored beside it.
 */
function llms(facts: Facts, skills: ReadonlyArray<Skill>): string {
	const from = "packages/docs-effect/dist/llms.txt";
	const lines = [
		"# pi-effect",
		"",
		`> ${facts.packages.length} packages that put Pi's durable agent harness into Effect ${facts.effect.replace(/^~/, "")}, with guards, budgets, model routing, records, review, approvals, subagents and swarms, composed into one agent thread that runs in one process or as a Rivet actor. For Pi ${facts.pi}. Each package's README is its documentation, and its examples are run by the package's tests.`,
		"",
		"Read a skill first when one matches the task: it says which package and export to use, the order that must not change, and what is not guaranteed, and it links into the READMEs.",
		"",
		"## Skills",
		"",
		...skills.map((skill) => `- [${skill.name}](${hrefFrom(from, skill.path)}): ${skill.description}`),
		"",
		"## Packages",
		"",
		...facts.packages.map(
			(pkg) =>
				`- [${pkg.name}](${hrefFrom(from, `packages/${pkg.directory}/README.md`)}) (${pkg.kind}): ${pkg.description}`,
		),
		"",
	];
	return lines.join("\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = resolve(process.argv[2] ?? join(HERE, "dist"));
	const written = build(directory);
	console.log(`docs: wrote ${written.length} files into ${directory}. Open ${join(directory, "index.html")}.`);
}
