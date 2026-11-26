// The skills of this package (`skills/<name>/SKILL.md`), and the contract each must keep so that an agent can trust
// one: what it links exists, what it names exists, and its code is code a README's test runs.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { type Facts, HERE, markdownIn, ROOT } from "./facts.ts";
import { codeBlocks, prose, render } from "./markdown.ts";

/** One skill as it is written. */
export interface Skill {
	/** Its directory name. */
	readonly directory: string;
	/** `SKILL.md`, as a path from the repository root. */
	readonly path: string;
	/** The keys of its frontmatter, in order, with their values as written. */
	readonly frontmatter: ReadonlyArray<readonly [string, string]>;
	readonly name: string;
	readonly description: string;
	/** `SKILL.md` without its frontmatter. */
	readonly body: string;
	/** Every Markdown file of the skill, `SKILL.md` first, as paths from the repository root. */
	readonly files: ReadonlyArray<string>;
}

/** The longest description an agent's harness takes, and the longest body that is still one read. */
export const LIMITS = { description: 1024, bodyLines: 300 } as const;

/** The files a skill is checked against: those of the repository, or a test's own in front of them. */
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

/** Every skill of this package, by directory name. A directory without a `SKILL.md` is reported by `problems`. */
export function readSkills(): Skill[] {
	return readdirSync(join(HERE, "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((directory) => {
			const path = `packages/docs-effect/skills/${directory}/SKILL.md`;
			const others = markdownIn(`packages/docs-effect/skills/${directory}`).filter((file) => file !== path);
			return parse(directory, DISK.read(path) ?? "", others);
		});
}

/** The skill of a directory whose `SKILL.md` holds `text`; `others` are its further Markdown files. */
export function parse(directory: string, text: string, others: ReadonlyArray<string> = []): Skill {
	const path = `packages/docs-effect/skills/${directory}/SKILL.md`;
	const matter = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	const frontmatter = (matter?.[1] ?? "")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line): readonly [string, string] => {
			const colon = line.indexOf(":");
			return colon === -1 ? [line, ""] : [line.slice(0, colon), line.slice(colon + 1).trim()];
		});
	const value = (key: string) => unquoted(frontmatter.find(([found]) => found === key)?.[1] ?? "");
	return {
		directory,
		path,
		frontmatter,
		name: value("name"),
		description: value("description"),
		body: text.slice(matter?.[0].length ?? 0),
		files: [path, ...others],
	};
}

/**
 * What of the contract a skill breaks, each as a sentence that says where; empty when it keeps all of it.
 *
 * - Frontmatter of exactly `name` and `description`: the name is the directory's, the description one line an
 *   agent's harness can parse as YAML and no longer than `LIMITS.description`.
 * - A body of at most `LIMITS.bodyLines` lines.
 * - Every relative link leads to a package's README or to a file of the skills, which exists, and its anchor is a
 *   heading there. So a skill reads the same vendored into a product, where no `src` and no `test` exist.
 * - Every package and entry point named is one of the library's.
 * - Every `ts` code block is a contiguous excerpt of a code block of a package's README, whose examples the
 *   package's own test runs.
 * - Every path of this repository named in backticks (under `packages/`, or a file or a directory with a trailing
 *   slash under `effect/`: `effect/ai` is a module of Effect), and every script of `effect/scripts` named anywhere,
 *   exists.
 */
export function problems(skill: Skill, facts: Facts, tree: Tree = DISK): string[] {
	const found: string[] = [];
	const keys = skill.frontmatter.map(([key]) => key);
	if (keys.join(",") !== "name,description") {
		found.push(`${skill.path}: the frontmatter is ${keys.join(", ") || "missing"}, not name then description`);
	}
	if (skill.name !== skill.directory) found.push(`${skill.path}: name "${skill.name}" is not its directory's`);
	const written = skill.frontmatter.find(([key]) => key === "description")?.[1] ?? "";
	if (skill.description === "") found.push(`${skill.path}: no description`);
	if (skill.description.length > LIMITS.description) {
		found.push(
			`${skill.path}: the description has ${skill.description.length} characters, over ${LIMITS.description}`,
		);
	}
	if (written === skill.description && /: | #|^[[{>|*&!%@`'"]/.test(written)) {
		found.push(
			`${skill.path}: the description holds ": " or " #" or begins with a YAML sign, so it must be in quotes`,
		);
	}
	const bodyLines = skill.body.trimEnd().split("\n").length;
	if (skill.body.trim() === "") found.push(`${skill.path}: no body`);
	if (bodyLines > LIMITS.bodyLines) found.push(`${skill.path}: ${bodyLines} lines, over ${LIMITS.bodyLines}`);

	const entries = new Set(facts.packages.flatMap((pkg) => pkg.entries));
	const examples = facts.packages.flatMap((pkg) => codeBlocks(pkg.readme).map((block) => block.lines));
	for (const file of skill.files) {
		const text = tree.read(file);
		if (text === undefined) {
			found.push(`${file}: no such file`);
			continue;
		}
		const said = prose(text);
		for (const [, target] of said.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
			if (target !== undefined) found.push(...linkProblems(file, target, tree));
		}
		for (const [name] of text.matchAll(/@gunta\/pi-[a-z-]+-effect(?:\/[a-z][a-z-]*)*/g)) {
			if (!entries.has(name) && name !== "@gunta/pi-docs-effect") {
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
				found.push(
					`${file}: the code block that begins \`${first.trim()}\` is no excerpt of a README's code block`,
				);
			}
		}
	}
	return found;
}

/** What is wrong with one link of a skill's file: where it leads, and whether its anchor is a heading there. */
function linkProblems(file: string, target: string, tree: Tree): string[] {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return [];
	const [path = "", anchor] = target.split("#");
	const resolved = path === "" ? file : normalize(join(dirname(file), path));
	const allowed =
		/^packages\/[a-z-]+-effect\/README\.md$/.test(resolved) || resolved.startsWith("packages/docs-effect/skills/");
	if (!allowed) return [`${file}: the link ${target} leads to neither a package's README nor a file of the skills`];
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

/** A YAML scalar without the quotes around it. */
function unquoted(value: string): string {
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	return quoted?.[1] ?? value;
}
