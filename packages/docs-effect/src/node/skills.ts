// The skills of this package (`skills/<name>/SKILL.md`): how an agent's harness finds the page of the documentation
// that fits a task. Each is a name, a description and a pointer into the pages, in the Agent Skills form Pi reads.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DISK, documentProblems, SKILLS, type Tree } from "./contract.ts";
import { type Facts, HERE, markdownIn } from "./facts.ts";

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

/** Every skill of this package, by directory name. A directory without a `SKILL.md` is reported by `problems`. */
export function readSkills(): Skill[] {
	return readdirSync(join(HERE, "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((directory) => {
			const path = `${SKILLS}/${directory}/SKILL.md`;
			const others = markdownIn(`${SKILLS}/${directory}`).filter((file) => file !== path);
			return parse(directory, DISK.read(path) ?? "", others);
		});
}

/** The skill of a directory whose `SKILL.md` holds `text`; `others` are its further Markdown files. */
export function parse(directory: string, text: string, others: ReadonlyArray<string> = []): Skill {
	const path = `${SKILLS}/${directory}/SKILL.md`;
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
 * What a skill breaks, each as a sentence that says where; empty when it keeps all of it.
 *
 * - Frontmatter of exactly `name` and `description`: the name is the directory's, the description one line an
 *   agent's harness can parse as YAML and no longer than `LIMITS.description`.
 * - A body of at most `LIMITS.bodyLines` lines.
 * - What every document of this package keeps (`documentProblems`), for each of its files.
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
	return [...found, ...skill.files.flatMap((file) => documentProblems(file, facts, tree))];
}

/** A YAML scalar without the quotes around it. */
function unquoted(value: string): string {
	const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
	return quoted?.[1] ?? value;
}
