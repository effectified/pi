// Fails when this branch changes a file outside the fork's boundary (PRD section 9.2), so `main` stays a pure mirror
// of upstream and every sync merges without conflicts in upstream files.
// Usage: node effect/scripts/check-boundary.ts [base]   (base defaults to `main`; CI passes `origin/main`)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./packages.ts";

/** Lines this fork adds to one upstream file, and why they cannot be avoided. */
interface RootLines {
	readonly file: string;
	readonly added: readonly string[];
	readonly reason: string;
}

const base = process.argv[2] ?? "main";
const mergeBase = git(["merge-base", base, "HEAD"]).trim();
// Trust boundary: boundary.json is a file, read as untyped JSON.
const rootLines: readonly RootLines[] = JSON.parse(readFileSync(join(ROOT, "effect/boundary.json"), "utf8")).rootLines;

// Tracked changes since the merge base, committed or not, and files git does not know yet.
const changed = new Set([
	...paths(git(["diff", "--name-only", "-z", mergeBase])),
	...paths(git(["ls-files", "--others", "--exclude-standard", "-z"])),
]);

/** Paths this fork owns outright. */
const OWNED = [
	/^packages\/[^/]+-effect\//,
	/^effect\//,
	/^\.github\/workflows\/effect-[^/]+\.yml$/,
	/^package-lock\.json$/,
];

const failures: string[] = [];
for (const file of [...changed].sort()) {
	if (OWNED.some((pattern) => pattern.test(file))) continue;
	const entries = rootLines.filter((entry) => entry.file === file);
	if (entries.length === 0) {
		failures.push(`${file}: outside the boundary`);
		continue;
	}
	failures.push(...unlistedChanges(file, new Set(entries.flatMap((entry) => entry.added))));
}

if (failures.length > 0) {
	console.error(`Changes outside the pi-effect boundary (against ${base}):`);
	for (const failure of failures) console.error(`  ${failure}`);
	console.error(
		"\nMove the change into packages/*-effect or effect/, or list the line in effect/boundary.json with its reason.",
	);
	process.exit(1);
}
console.log(`Boundary holds: ${changed.size} changed files against ${base}.`);

/** What boundary.json does not list of an upstream file's changes: a removed line, or an added one not in `allowed`. */
function unlistedChanges(file: string, allowed: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	for (const line of git(["diff", "--unified=0", mergeBase, "--", file]).split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("-")) problems.push(`${file}: removes an upstream line: ${line.slice(1).trim()}`);
		else if (line.startsWith("+") && !allowed.has(line.slice(1).trim())) {
			problems.push(`${file}: adds a line boundary.json does not list: ${line.slice(1).trim()}`);
		}
	}
	return problems;
}

function git(args: readonly string[]): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function paths(output: string): string[] {
	return output.split("\0").filter((path) => path !== "");
}
