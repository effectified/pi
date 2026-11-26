#!/usr/bin/env node
// Links every skill of this package into a project, where an agent's harness looks for skills: `.claude/skills`
// (Claude Code) and `.agents/skills` (Codex and others). A link, not a copy, so the skills stay the ones of the
// packages the project has. Plain JavaScript: it runs where only the built package is, in a product's vendor folder.
// The two skills for work inside the pi-effect repository are linked only into that repository.
// Usage: node link-skills.mjs [project directory [skills directory ...]]
//   The project defaults to the current directory, the skills directories to `.claude/skills` and `.agents/skills`.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real paths on both sides: a relative link is followed from where its directory really is, which is not where a
// path through a linked directory (macOS's `/tmp`, a linked checkout) says it is.
const skills = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../skills"));
const project = resolve(process.argv[2] ?? ".");
const homes = process.argv.length > 3 ? process.argv.slice(3) : [".claude/skills", ".agents/skills"];
const REPOSITORY_ONLY = ["pi-effect-contributing", "pi-effect-upstream-sync"];
const isRepository = existsSync(join(project, "effect/scripts/gate.ts"));
const names = readdirSync(skills, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(skills, entry.name, "SKILL.md")))
	.map((entry) => entry.name)
	.filter((name) => isRepository || !REPOSITORY_ONLY.includes(name))
	.sort();

const failures = [];
let linked = 0;
for (const home of homes) {
	mkdirSync(join(project, home), { recursive: true });
	const directory = realpathSync(join(project, home));
	for (const name of names) {
		const link = join(directory, name);
		const target = relative(directory, join(skills, name));
		const found = lstatSync(link, { throwIfNoEntry: false });
		if (found?.isSymbolicLink()) {
			if (readlinkSync(link) === target) continue;
			// A link of an earlier run, to where the packages were then.
			unlinkSync(link);
		} else if (found !== undefined) {
			failures.push(`${join(home, name)} exists and is no link: it is the project's own, and was left as it is`);
			continue;
		}
		symlinkSync(target, link, "dir");
		linked++;
	}
}

console.log(`${names.length} skills (${names.join(", ")}): ${linked} links made in ${project}.`);
if (failures.length > 0) {
	for (const failure of failures) console.error(failure);
	process.exit(1);
}
