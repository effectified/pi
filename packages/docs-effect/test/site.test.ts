// The built site: every package has its page and its place on the landing page, every link between pages leads
// somewhere, and nothing is stated that the tree does not hold.

import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "../src/node/build.ts";
import { HERE, read } from "../src/node/facts.ts";
import { packagePage, skillPage } from "../src/node/layout.ts";
import { readSkills } from "../src/node/skills.ts";

const facts = read();
const skills = readSkills();
const files = site(facts, skills);
const pages = [...files].filter(([path]) => path.endsWith(".html"));
const landing = files.get("index.html") ?? "";

/** The targets of a page's links, as the page writes them. */
const linksOf = (html: string): string[] =>
	[...html.matchAll(/href="([^"]*)"/g)].map(([, href = ""]) => href.replaceAll("&amp;", "&"));

/** A path that leaves the site, as a path on disk: the site is built into this package's `dist`. */
const onDisk = (path: string): string => join(HERE, "dist", path);

describe("the site", () => {
	it("is the landing page, a page for each package and each file of a skill, and llms.txt", () => {
		const expected = [
			"index.html",
			"llms.txt",
			...facts.packages.map((pkg) => packagePage(pkg.directory)),
			...skills.flatMap((skill) => skill.files.map(skillPage)),
		];
		expect([...files.keys()].sort()).toEqual(expected.sort());
		expect(facts.packages.length).toBeGreaterThanOrEqual(15);
	});

	it("gives every package a place in the stack and a row in a table of the landing page, with its role", () => {
		for (const pkg of facts.packages) {
			const address = `href="${packagePage(pkg.directory)}"`;
			expect(landing.split(address).length - 1, pkg.directory).toBeGreaterThanOrEqual(2);
			expect(landing, pkg.directory).toContain(`data-role="${pkg.role.replaceAll("'", "&#39;")}"`);
			expect(landing, pkg.directory).toContain(`<td class="count">${pkg.tests}</td>`);
		}
	});

	it("states the versions and the count of tests the tree has", () => {
		const tests = facts.packages.reduce((sum, pkg) => sum + pkg.tests, 0);
		expect(landing).toContain(`${facts.packages.length} packages, ${tests.toLocaleString("en-US")} tests`);
		expect(landing).toContain(`For Pi ${facts.pi}`);
		expect(facts.pi).toMatch(/^\d+\.\d+\.\d+$/);
		// The pages of the READMEs use these words of their own accord; the two written here must not.
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
					// Out of the site: the Markdown an agent reads, beside it on disk.
					if (!resolved.startsWith("..") || !existsSync(onDisk(resolved)))
						failures.push(`${path}: ${href} leads nowhere`);
				} else if (anchor !== undefined && anchor !== "" && !found.includes(`id="${anchor}"`)) {
					failures.push(`${path}: ${href} names a heading the page does not have`);
				}
			}
		}
		expect(failures).toEqual([]);
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

	it("names every package and every skill, one line each", () => {
		for (const pkg of facts.packages) expect(index).toContain(`- [${pkg.name}](`);
		for (const skill of skills) expect(index).toContain(`- [${skill.name}](`);
	});

	it("links the Markdown of each, where it lies beside the built site", () => {
		const targets = [...index.matchAll(/\]\(([^)]+)\)/g)].map(([, target = ""]) => target);
		expect(targets.length).toBe(facts.packages.length + skills.length);
		expect(targets.filter((target) => !existsSync(onDisk(target)))).toEqual([]);
	});
});
