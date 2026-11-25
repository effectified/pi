// Runs the Effect language service's diagnostics on the pi-effect packages: @effect/tsgo, at the exact version below,
// on effect/tsconfig.json, whose plugin block makes the rules of effect/AGENTS.md errors (floating Effects, time and
// ids from services, no `node:` import in a core, unstable modules by decision). Fails on any error and prints each;
// warnings and suggestions are counted by rule. The tool is not a dependency: the root package.json is upstream's, and
// its platform binary is 268 MB, so `npm exec` fetches it into npm's cache.
// Usage: node effect/scripts/effect-diagnostics.ts

import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { ROOT } from "./packages.ts";

/** One diagnostic of `effect-tsgo diagnostics --format json`. */
interface Diagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly severity: string;
	readonly name: string;
	readonly message: string;
}

const TSGO = "@effect/tsgo@0.73.4";

const started = performance.now();
const project = join(ROOT, "effect/tsconfig.json");
const args = ["exec", "--yes", `--package=${TSGO}`, "--", "effect-tsgo", "diagnostics", "--project", project];
const result = spawnSync("npm", [...args, "--format", "json"], {
	cwd: ROOT,
	encoding: "utf8",
	maxBuffer: 256 * 1024 * 1024,
	stdio: ["ignore", "pipe", "inherit"],
});
const report = parse(result.stdout);
if (report === undefined) {
	console.error(`effect-diagnostics: ${TSGO} gave no report (exit ${result.status}):\n${result.stdout}`);
	process.exit(1);
}
const failures: string[] = [];
if (report.unchecked > 0) {
	failures.push(`${report.unchecked} files were checked without the plugin: effect/tsconfig.json has no plugin block`);
}
const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
for (const error of errors) {
	const where = `${relative(ROOT, error.file)}:${error.line}:${error.column}`;
	failures.push(`${where} ${error.name}: ${error.message}`);
	if (process.env.GITHUB_ACTIONS === "true") {
		console.log(`::error file=${relative(ROOT, error.file)},line=${error.line},col=${error.column}::${error.name}`);
	}
}
const others = new Map<string, number>();
for (const diagnostic of report.diagnostics) {
	if (diagnostic.severity === "error") continue;
	const key = `${diagnostic.severity} ${diagnostic.name}`;
	others.set(key, (others.get(key) ?? 0) + 1);
}
const counted = [...others].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${count} ${key}`);
if (counted.length > 0) {
	console.log(`Not failing: ${counted.join(", ")}.`);
	console.log(`All of them: npm ${args.join(" ")}`);
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
	console.error(`\nEffect diagnostics failed (${report.checked} files, ${seconds} s):`);
	for (const failure of failures.sort()) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`Effect diagnostics: no error in ${report.checked} files (${seconds} s).`);

/** The diagnostics and file counts of the tool's JSON report; undefined when the output is not one. */
function parse(
	output: string,
): { readonly diagnostics: Diagnostic[]; readonly checked: number; readonly unchecked: number } | undefined {
	try {
		// Trust boundary: the output of an external tool, read as untyped JSON.
		const json = JSON.parse(output);
		if (!Array.isArray(json.diagnostics) || typeof json.summary?.filesChecked !== "number") return undefined;
		return {
			diagnostics: json.diagnostics,
			checked: json.summary.filesChecked,
			unchecked: Number(json.summary.filesWithoutPlugin ?? 0),
		};
	} catch {
		return undefined;
	}
}
