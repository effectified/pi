// The documentation as Pi keeps its own (`packages/coding-agent/docs` upstream): a directory of Markdown pages and a
// catalog, `docs.json`, whose navigation names every page. The rules a catalog must keep are those of upstream's
// `packages/coding-agent/test/documentation.test.ts`, so these pages could be put beside Pi's without a change.

import { posix } from "node:path";
import { lexer, type Token, walkTokens } from "marked";
import { DISK, DOCS, type Tree } from "./contract.ts";
import { markdownIn } from "./facts.ts";

/** One entry of the navigation: a page, a group of entries, or a page with entries under it. */
export interface Item {
	readonly title: string;
	/** A page, as a path from the documentation's directory: `threads.md`. */
	readonly path: string | undefined;
	readonly items: ReadonlyArray<Item>;
}

/** A top-level group of the navigation. */
export interface Group {
	readonly title: string;
	readonly items: ReadonlyArray<Item>;
}

/** The catalog as it is written. */
export interface Catalog {
	readonly groups: ReadonlyArray<Group>;
	/** Every page the navigation names, in its order, with the title the navigation gives it. */
	readonly pages: ReadonlyArray<{ readonly path: string; readonly title: string }>;
}

/** The catalog of this package's documentation. Throws, saying where, when `docs.json` is not a catalog. */
export function readCatalog(tree: Tree = DISK): Catalog {
	const text = tree.read(`${DOCS}/docs.json`);
	if (text === undefined) throw new Error(`${DOCS}/docs.json: no such file`);
	// Trust boundary: the catalog is a file, read as untyped JSON and checked field by field below.
	return parseCatalog(JSON.parse(text));
}

/** A catalog from the value of a `docs.json`. Throws, saying where, when a field is missing, wrong or unknown. */
export function parseCatalog(value: unknown): Catalog {
	const catalog = record(value, "Documentation catalog");
	fields(catalog, ["navigation", "redirects"], "Documentation catalog");
	if (!Array.isArray(catalog.navigation)) throw new Error("Documentation catalog navigation must be an array");
	const groups = catalog.navigation.map((raw: unknown, index: number): Group => {
		const location = `Documentation catalog navigation[${index}]`;
		const group = record(raw, location);
		fields(group, ["title", "items"], location);
		return { title: text(group.title, `${location}.title`), items: items(group.items, location) };
	});
	const pages: Array<{ path: string; title: string }> = [];
	const visit = (entries: ReadonlyArray<Item>): void => {
		for (const item of entries) {
			if (item.path !== undefined) pages.push({ path: item.path, title: item.title });
			visit(item.items);
		}
	};
	for (const group of groups) visit(group.items);
	return { groups, pages };
}

/** The Markdown pages of the documentation's directory, by their path from it. */
export function readPages(): ReadonlyMap<string, string> {
	return new Map(markdownIn(DOCS).map((file) => [file.slice(DOCS.length + 1), DISK.read(file) ?? ""] as const));
}

/**
 * What a catalog breaks, each as a sentence; empty when it keeps all of it. `pages` are the Markdown files of the
 * documentation's directory. Upstream's rules, in upstream's words:
 *
 * - no page is named twice by the navigation, and every page it names exists;
 * - every local Markdown link of a page that can be reached leads to a file;
 * - no two pages have one public address (`a.md` and `a/index.md`);
 * - no page is orphaned: each is named by the navigation, or linked from a page that is.
 */
export function catalogProblems(catalog: Catalog, pages: ReadonlyMap<string, string>, tree: Tree = DISK): string[] {
	const roots = catalog.pages.map((page) => page.path);
	const duplicates = [...new Set(roots.filter((path, index) => roots.indexOf(path) !== index))].sort();
	const missing = roots.filter((path) => !pages.has(path)).sort();

	const bySlug = new Map<string, string[]>();
	for (const path of pages.keys()) bySlug.set(slug(path), [...(bySlug.get(slug(path)) ?? []), path]);
	const collisions = [...bySlug]
		.filter(([, paths]) => paths.length > 1)
		.map(([address, paths]) => `${address || "/"} (${paths.join(", ")})`)
		.sort();

	const reachable = new Set<string>();
	const pending = roots.filter((path) => pages.has(path));
	const broken: string[] = [];
	while (pending.length > 0) {
		const source = pending.shift();
		if (source === undefined || reachable.has(source)) continue;
		reachable.add(source);
		for (const href of links(pages.get(source) ?? "")) {
			if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("/")) continue;
			const linked = href.split(/[?#]/, 1)[0] ?? "";
			if (!linked.endsWith(".md")) continue;
			const target = posix.normalize(posix.join(posix.dirname(source), linked));
			// A link out of the documentation's directory (a package's README) must exist, and is no page of it.
			if (target === ".." || target.startsWith("../")) {
				if (tree.read(posix.normalize(posix.join(DOCS, target))) === undefined) broken.push(`${source} -> ${href}`);
			} else if (!pages.has(target)) broken.push(`${source} -> ${href}`);
			else if (!reachable.has(target)) pending.push(target);
		}
	}
	const orphaned = [...pages.keys()].filter((path) => !reachable.has(path)).sort();
	return [
		...(duplicates.length > 0 ? [`Duplicate navigation paths: ${duplicates.join(", ")}`] : []),
		...(missing.length > 0 ? [`Missing navigation pages: ${missing.join(", ")}`] : []),
		...(broken.length > 0 ? [`Broken local Markdown links: ${broken.sort().join(", ")}`] : []),
		...(collisions.length > 0 ? [`Duplicate public documentation slugs: ${collisions.join("; ")}`] : []),
		...(orphaned.length > 0 ? [`Orphaned Markdown pages: ${orphaned.join(", ")}`] : []),
	];
}

/** The public address of a page under the documentation's root: `index.md` is the root itself. */
export function slug(path: string): string {
	const bare = path.slice(0, -".md".length);
	if (bare === "index") return "";
	return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare;
}

/** The targets of a page's Markdown links. */
function links(markdown: string): string[] {
	const found: string[] = [];
	walkTokens(lexer(markdown), (token: Token) => {
		if (token.type === "link" && typeof token.href === "string") found.push(token.href);
	});
	return found;
}

/** The entries of a navigation group or of an entry. */
function items(value: unknown, location: string): Item[] {
	if (!Array.isArray(value)) throw new Error(`${location}.items must be an array`);
	if (value.length === 0) throw new Error(`${location}.items must contain at least one item`);
	return value.map((raw: unknown, index: number): Item => {
		const at = `${location}.items[${index}]`;
		const item = record(raw, at);
		fields(item, ["title", "path", "items"], at);
		const path = item.path === undefined ? undefined : pagePath(item.path, `${at}.path`);
		if (path === undefined && item.items === undefined) throw new Error(`${at} must have a path or items`);
		return {
			title: text(item.title, `${at}.title`),
			path,
			items: item.items === undefined ? [] : items(item.items, at),
		};
	});
}

function record(value: unknown, location: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${location} must be an object`);
	}
	return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, location: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${location} must be a nonempty string`);
	return value;
}

function fields(value: Record<string, unknown>, known: ReadonlyArray<string>, location: string): void {
	const unknown = Object.keys(value)
		.filter((field) => !known.includes(field))
		.sort();
	if (unknown.length > 0) throw new Error(`${location} has unsupported fields: ${unknown.join(", ")}`);
}

/** A page's path as the catalog may write it: relative, normalized, inside the directory, ending in `.md`. */
function pagePath(value: unknown, location: string): string {
	const path = text(value, location);
	const normalized = posix.normalize(path);
	const escapes = normalized === ".." || normalized.startsWith("../");
	const url = path.includes("?") || path.includes("#");
	const windows = path.includes("\\") || /^[a-z]:/i.test(path);
	if (
		path !== path.trim() ||
		path !== normalized ||
		posix.isAbsolute(path) ||
		escapes ||
		url ||
		windows ||
		!path.endsWith(".md")
	) {
		throw new Error(`${location} must be a relative normalized .md path`);
	}
	return path;
}
