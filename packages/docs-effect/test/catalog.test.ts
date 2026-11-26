// The documentation's catalog and pages: Pi's own rules for a `docs.json` hold, every page keeps the contract, and
// each rule is shown a catalog that breaks it.

import { describe, expect, it } from "vitest";
import { catalogProblems, parseCatalog, readCatalog, readPages, slug } from "../src/node/catalog.ts";
import { DISK, DOCS, documentProblems, type Tree } from "../src/node/contract.ts";
import { read } from "../src/node/facts.ts";
import { prose } from "../src/node/markdown.ts";

const facts = read();
const catalog = readCatalog();
const pages = readPages();

/** A catalog of one group whose items are `items`. */
const of = (items: unknown) => parseCatalog({ navigation: [{ title: "Group", items }] });

/** A page of the documentation named `fixture.md` that holds `text`, checked with that file in front of the tree. */
const brokenPage = (text: string): string[] => {
	const file = `${DOCS}/fixture.md`;
	const tree: Tree = {
		read: (path) => (path === file ? text : DISK.read(path)),
		exists: (path) => path === file || DISK.exists(path),
	};
	return documentProblems(file, facts, tree);
};

describe("the documentation of this package", () => {
	it("keeps the rules Pi's own catalog keeps", () => {
		expect(catalogProblems(catalog, pages)).toEqual([]);
	});

	it("has Pi's three groups, and names every page of the directory once", () => {
		expect(catalog.groups.map((group) => group.title)).toEqual(["Get Started", "Guides", "Reference"]);
		expect(catalog.pages.map((page) => page.path).sort()).toEqual([...pages.keys()].sort());
		expect(catalog.pages[0]).toEqual({ path: "index.md", title: "Overview" });
	});

	it("gives every page one title, which the navigation names it by or which says the same thing", () => {
		for (const [path, text] of pages) {
			const titles = prose(text)
				.split("\n")
				.filter((line) => line.startsWith("# "));
			expect(titles.length, path).toBe(1);
			expect(text.startsWith("# "), path).toBe(true);
		}
		const named = new Map(catalog.pages.map((page) => [page.path, page.title]));
		for (const path of ["threads.md", "rivet.md", "extending.md", "testing.md", "agents.md", "packages.md"]) {
			expect(pages.get(path)?.split("\n")[0], path).toBe(`# ${named.get(path)}`);
		}
	});

	it("keeps the contract in every page: links, names, and code a README's test runs", () => {
		expect([...pages.keys()].flatMap((path) => documentProblems(`${DOCS}/${path}`, facts))).toEqual([]);
	});

	it("covers every package: the package page names each one and links its README", () => {
		const text = pages.get("packages.md") ?? "";
		for (const pkg of facts.packages) {
			expect(text, pkg.name).toContain(`\`${pkg.name}\``);
			expect(text, pkg.name).toContain(`](../../${pkg.directory}/README.md)`);
		}
	});
});

describe("a catalog", () => {
	it("is read as Pi reads one: a group has a title and items, an item a path or items", () => {
		const read = of([
			{ title: "A", path: "a.md", items: [{ title: "B", path: "sub/b.md" }] },
			{ title: "C", items: [{ title: "D", path: "d.md" }] },
		]);
		expect(read.pages).toEqual([
			{ path: "a.md", title: "A" },
			{ path: "sub/b.md", title: "B" },
			{ path: "d.md", title: "D" },
		]);
		expect(parseCatalog({ navigation: [], redirects: [] }).groups).toEqual([]);
	});

	it("is refused, saying where, when a field is unknown, missing or no page's path", () => {
		expect(() => parseCatalog({ navigation: [], theme: "dark" })).toThrow("unsupported fields: theme");
		expect(() => parseCatalog({ navigation: [{ title: "G", items: [] }] })).toThrow("must contain at least one item");
		expect(() => of([{ title: "A" }])).toThrow("navigation[0].items[0] must have a path or items");
		expect(() => of([{ title: "", path: "a.md" }])).toThrow("items[0].title must be a nonempty string");
		for (const path of ["../a.md", "/a.md", "a.md#b", "a.html", "./a.md", "a\\b.md"]) {
			expect(() => of([{ title: "A", path }]), path).toThrow("must be a relative normalized .md path");
		}
	});

	it("names a page listed twice, one that is missing, and one nothing leads to", () => {
		const twice = of([
			{ title: "A", path: "a.md" },
			{ title: "Again", path: "a.md" },
			{ title: "Gone", path: "gone.md" },
		]);
		const files = new Map([
			["a.md", "# A\n"],
			["alone.md", "# Alone\n"],
		]);
		expect(catalogProblems(twice, files)).toEqual([
			"Duplicate navigation paths: a.md",
			"Missing navigation pages: gone.md",
			"Orphaned Markdown pages: alone.md",
		]);
	});

	it("reaches a page through a link, and names a link that leads to no file, in the directory or out of it", () => {
		const linked = of([{ title: "A", path: "a.md" }]);
		const files = new Map([
			["a.md", "# A\n\n[B](b.md) [gone](no.md) [out](../../no-such-effect/README.md)\n"],
			["b.md", "# B\n"],
		]);
		expect(catalogProblems(linked, files)).toEqual([
			"Broken local Markdown links: a.md -> ../../no-such-effect/README.md, a.md -> no.md",
		]);
		const out = new Map([["a.md", "# A\n\n[Thread](../../thread-effect/README.md#gaps) [site](https://pi.dev)\n"]]);
		expect(catalogProblems(linked, out)).toEqual([]);
	});

	it("names two pages that would have one address", () => {
		const both = of([
			{ title: "A", path: "a.md" },
			{ title: "A again", path: "a/index.md" },
		]);
		const files = new Map([
			["a.md", "# A\n"],
			["a/index.md", "# A\n"],
		]);
		expect(catalogProblems(both, files)).toEqual(["Duplicate public documentation slugs: a (a.md, a/index.md)"]);
		expect([slug("index.md"), slug("a.md"), slug("a/index.md"), slug("a/b.md")]).toEqual(["", "a", "a", "a/b"]);
	});
});

describe("a page", () => {
	it("may link a page, a README's heading and a skill, and quote a README's example", () => {
		const text = `# Fixture

See [threads](threads.md#wiring-it), [the composition](../../thread-effect/README.md#the-composition) and
[a skill](../skills/pi-effect/SKILL.md).

\`\`\`ts
const outcome = Threads.Threads.use((threads) =>
	threads.work({
\`\`\`
`;
		expect(brokenPage(text)).toEqual([]);
	});

	it("is named for a link into a package's source, a heading that is gone, and code no README has", () => {
		expect(brokenPage("# F\n\n[src](../../thread-effect/src/index.ts)\n")).toEqual([
			expect.stringContaining("leads to neither a page, a package's README nor a file of the skills"),
		]);
		expect(brokenPage("# F\n\n[gone](threads.md#no-such-heading)\n")).toEqual([
			expect.stringContaining(`names a heading ${DOCS}/threads.md does not have`),
		]);
		expect(brokenPage("# F\n\n```ts\nconst thread = yield* Threads.make();\n```\n")).toEqual([
			expect.stringContaining("is no excerpt of a README's code block"),
		]);
	});
});
