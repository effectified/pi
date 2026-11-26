// What every page and every skill must keep so that a reader, a person or an agent, can act on it without checking:
// what it links exists, what it names exists, and its code is code a README's test runs.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { type Facts, ROOT } from "./facts.ts";
import { codeBlocks, prose, render } from "./markdown.ts";

/** The files a document is checked against: those of the repository, or a test's own in front of them. */
export interface Tree {
	/** The text of the file at a path from the repository root; undefined when there is no file there. */
	readonly read: (path: string) => string | undefined;
	/** Whether a file or a directory is at the path. */
	readonly exists: (path: string) => boolean;
}

/** The repository's files. */
export const DISK: Tree = {
	read: (path) => {
		const absolute = join(ROOT, path);
		return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : undefined;
	},
	exists: (path) => existsSync(join(ROOT, path)),
};

/** The directory of the documentation's pages, from the repository root. */
export const DOCS = "packages/docs-effect/docs";

/** The directory of the skills, from the repository root. */
export const SKILLS = "packages/docs-effect/skills";

/**
 * What a Markdown document of this package breaks, each as a sentence that says where; empty when it keeps all of it.
 *
 * - Every relative link leads to a page of the documentation, to a package's README or to a file of the skills,
 *   which exists, and its anchor is a heading there. So a document reads the same vendored into a product, where
 *   the packages are built and have no `src` and no `test`.
 * - Every package and entry point named is one of the library's.
 * - Every `ts` code block is a contiguous excerpt of a code block of a package's README, whose examples the
 *   package's own test runs.
 * - Every path of this repository named in backticks (under `packages/`, or a file or a directory with a trailing
 *   slash under `effect/`: `effect/ai` is a module of Effect), and every script of `effect/scripts` named anywhere,
 *   exists.
 */
export function documentProblems(file: string, facts: Facts, tree: Tree = DISK): string[] {
	const text = tree.read(file);
	if (text === undefined) return [`${file}: no such file`];
	const found: string[] = [];
	const entries = new Set(facts.packages.flatMap((pkg) => pkg.entries));
	const examples = facts.packages.flatMap((pkg) => codeBlocks(pkg.readme).map((block) => block.lines));
	const said = prose(text);
	for (const [, target] of said.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
		if (target !== undefined) found.push(...linkProblems(file, target, tree));
	}
	for (const [name] of text.matchAll(/@effectified\/pi-[a-z]+(?:-[a-z]+)*(?:\/[a-z][a-z-]*)*/g)) {
		if (!entries.has(name) && name !== "@effectified/pi-docs") {
			found.push(`${file}: ${name} is no package or entry point of the library`);
		}
	}
	for (const [, path] of said.matchAll(/`(packages\/[\w./-]+|effect\/[\w./-]*(?:\.\w+|\/))`/g)) {
		if (path !== undefined && !tree.exists(path)) found.push(`${file}: \`${path}\` does not exist`);
	}
	for (const [script] of text.matchAll(/effect\/scripts\/[\w-]+\.ts/g)) {
		if (!tree.exists(script)) found.push(`${file}: the script ${script} does not exist`);
	}
	for (const block of codeBlocks(text)) {
		if (block.lang !== "ts" && block.lang !== "typescript") continue;
		if (!examples.some((example) => isExcerpt(block.lines, example))) {
			const first = block.lines.find((line) => line.trim() !== "") ?? "";
			found.push(`${file}: the code block that begins \`${first.trim()}\` is no excerpt of a README's code block`);
		}
	}
	return found;
}

/** What is wrong with one link of a document: where it leads, and whether its anchor is a heading there. */
function linkProblems(file: string, target: string, tree: Tree): string[] {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return [];
	const [path = "", anchor] = target.split("#");
	const resolved = path === "" ? file : normalize(join(dirname(file), path));
	const allowed =
		/^packages\/[a-z-]+-effect\/README\.md$/.test(resolved) ||
		resolved.startsWith(`${DOCS}/`) ||
		resolved.startsWith(`${SKILLS}/`);
	if (!allowed) {
		return [`${file}: the link ${target} leads to neither a page, a package's README nor a file of the skills`];
	}
	const text = tree.read(resolved);
	if (text === undefined) return [`${file}: the link ${target} leads to no file`];
	if (anchor === undefined || anchor === "" || !resolved.endsWith(".md")) return [];
	const headings = render(text).headings;
	return headings.some((heading) => heading.id === anchor)
		? []
		: [`${file}: the link ${target} names a heading ${resolved} does not have`];
}

/** Whether `lines` are consecutive lines of `block`, each side's own indentation aside. */
function isExcerpt(lines: ReadonlyArray<string>, block: ReadonlyArray<string>): boolean {
	const wanted = dedented(trimmed(lines));
	if (wanted.length === 0) return true;
	for (let start = 0; start + wanted.length <= block.length; start++) {
		const window = dedented(block.slice(start, start + wanted.length));
		if (window.every((line, index) => line === wanted[index])) return true;
	}
	return false;
}

/** Lines without the empty ones at their beginning and end. */
function trimmed(lines: ReadonlyArray<string>): ReadonlyArray<string> {
	const first = lines.findIndex((line) => line.trim() !== "");
	const last = lines.findLastIndex((line) => line.trim() !== "");
	return first === -1 ? [] : lines.slice(first, last + 1);
}

/** Lines without the indentation they all share, and without trailing space. */
function dedented(lines: ReadonlyArray<string>): string[] {
	const indents = lines.filter((line) => line.trim() !== "").map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
	const shared = indents.length === 0 ? 0 : Math.min(...indents);
	return lines.map((line) => line.slice(shared).trimEnd());
}
