// The built site: every page of the catalog and every package has its page, every link between pages leads
// somewhere, and nothing is stated that the tree does not hold.

import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { broken, site, sources } from "../src/node/build.ts";
import { HERE } from "../src/node/facts.ts";
import { docsPage, packagePage } from "../src/node/layout.ts";

const from = sources();
const { facts, catalog, skills } = from;
const files = site(from);
const pages = [...files].filter(([path]) => path.endsWith(".html"));
const landing = files.get("index.html") ?? "";

/** The targets of a page's links, as the page writes them. */
const linksOf = (html: string): string[] =>
	[...html.matchAll(/href="([^"]*)"/g)].map(([, href = ""]) => href.replaceAll("&amp;", "&"));

/** A path that leaves the site, as a path on disk: the site is built into this package's `dist`. */
const onDisk = (path: string): string => join(HERE, "dist", path);

describe("the site", () => {
	it("is built from sources that break no rule", () => {
		expect(broken(from)).toEqual([]);
	});

	it("is the landing page, a page for each page of the catalog and for each package, and llms.txt", () => {
		const expected = [
			"index.html",
			"llms.txt",
			...catalog.pages.map((page) => docsPage(page.path)),
			...facts.packages.map((pkg) => packagePage(pkg.directory)),
		];
		expect([...files.keys()].sort()).toEqual(expected.sort());
		expect(facts.packages.length).toBeGreaterThanOrEqual(15);
		expect(files.has("docs/index.html")).toBe(true);
	});

	it("gives every page the catalog's navigation, in its order, and every package's README", () => {
		const whole = files.get(docsPage("threads.md")) ?? "";
		const page = whole.slice(whole.indexOf('<nav class="rail"'));
		const positions = catalog.pages.map(({ path }) =>
			page.indexOf(path === "threads.md" ? 'aria-current="page"' : `href="${docsPage(path).slice("docs/".length)}"`),
		);
		expect(positions.every((position) => position !== -1)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		for (const group of catalog.groups) expect(page).toContain(`<h2>${group.title}</h2>`);
		for (const pkg of facts.packages) expect(page).toContain(`href="../${packagePage(pkg.directory)}"`);
	});

	it("gives every package a place in the stack and a row in a table of the landing page, with its role", () => {
		for (const pkg of facts.packages) {
			const address = `href="${packagePage(pkg.directory)}"`;
			expect(landing.split(address).length - 1, pkg.directory).toBeGreaterThanOrEqual(2);
			expect(landing, pkg.directory).toContain(`data-role="${pkg.role.replaceAll("'", "&#39;")}"`);
			expect(landing, pkg.directory).toContain(`<td class="count">${pkg.tests}</td>`);
		}
		for (const skill of skills) expect(landing).toContain(`<code>${skill.name}</code>`);
	});

	it("states the versions and the count of tests the tree has", () => {
		const tests = facts.packages.reduce((sum, pkg) => sum + pkg.tests, 0);
		expect(landing).toContain(`${facts.packages.length} packages, ${tests.toLocaleString("en-US")} tests`);
		expect(landing).toContain(`For Pi ${facts.pi}`);
		expect(facts.pi).toMatch(/^\d+\.\d+\.\d+$/);
		// The pages of the READMEs and of the catalog use these words of their own accord; the two written here must not.
		for (const path of ["index.html", "llms.txt"]) {
			expect(files.get(path), path).not.toMatch(/\bundefined\b|\[object Object\]|\bNaN\b/);
		}
	});

	it("shows the composition's own example, as its README has it", () => {
		const composition = facts.packages.find((pkg) => pkg.kind === "composition");
		expect(composition?.readme).toContain("Composition.open(");
		expect(landing).toContain("Composition.open(");
		expect(landing).toContain("threads.work(");
	});

	it("leads every link of every page to a page, and every anchor to a heading there", () => {
		const failures: string[] = [];
		for (const [path, html] of pages) {
			for (const href of linksOf(html)) {
				if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
				const [target = "", anchor] = href.split("#");
				const resolved = target === "" ? path : normalize(join(dirname(path), target));
				const found = files.get(resolved);
				if (found === undefined) {
					// Out of the site: a file beside it on disk.
					if (!resolved.startsWith("..") || !existsSync(onDisk(resolved)))
						failures.push(`${path}: ${href} leads nowhere`);
				} else if (anchor !== undefined && anchor !== "" && !found.includes(`id="${anchor}"`)) {
					failures.push(`${path}: ${href} names a heading the page does not have`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("turns a link between pages, and one from a page into a README, into links between their pages", () => {
		const overview = files.get("docs/index.html") ?? "";
		expect(overview).toContain('<a href="quickstart.html">Quickstart</a>');
		expect(overview).toContain('href="../packages/thread-effect.html#gaps"');
		const readme = files.get(packagePage("thread-effect")) ?? "";
		expect(readme).toContain('href="durable-rivet-effect.html"');
		expect(readme).toMatch(/href="https:\/\/github\.com\/[^"]+\/(?:tree|blob)\/effect\/packages\/durable/);
	});

	it("writes a README's code as text, and loads nothing from outside the page", () => {
		const page = files.get(packagePage("durable-effect")) ?? "";
		expect(page).toContain("<pre><code");
		expect(page).not.toMatch(/<script/);
		for (const [path, html] of pages) {
			expect(html, path).not.toMatch(/<link[^>]+rel="stylesheet"|<script[^>]+src=|<img|<iframe/);
		}
	});
});

describe("llms.txt", () => {
	const index = files.get("llms.txt") ?? "";

	it("names every page, every package and every skill, one line each", () => {
		for (const page of catalog.pages) expect(index).toContain(`- [${page.title}](`);
		for (const pkg of facts.packages) expect(index).toContain(`- [${pkg.name}](`);
		for (const skill of skills) expect(index).toContain(`- [${skill.name}](`);
	});

	it("links the Markdown of each, where it lies beside the built site", () => {
		const targets = [...index.matchAll(/\]\(([^)]+)\)/g)].map(([, target = ""]) => target);
		expect(targets.length).toBe(catalog.pages.length + facts.packages.length + skills.length);
		expect(targets.filter((target) => !existsSync(onDisk(target)))).toEqual([]);
	});
});
