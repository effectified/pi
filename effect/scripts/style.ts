// Formatting and lint of the pi-effect packages and of this directory, with VoidZero's oxc tools: oxfmt
// (effect/oxfmt.json) and oxlint (effect/oxlint.json, with the idiom rules of effect/idioms/plugin.ts). Upstream's
// Biome leaves these paths to them (the line of root biome.json listed in effect/boundary.json). The tools are not
// dependencies, as @effect/tsgo is not: the root package.json is upstream's, so `npm exec` fetches each at the exact
// version below into npm's cache. Only TypeScript files are formatted: a README or a docs page is quoted by tests.
// Usage: node effect/scripts/style.ts [--write] [path ...]
//   no path: every packages/*-effect directory and effect/
//   --write: format the files in place (the lint still only reports)

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { effectPackages, ROOT } from "./packages.ts";

/** The exact versions run; oxlint is one @effect/tsgo supports, should its Effect-patched build be used. */
export const OXFMT = "oxfmt@0.80.0";
export const OXLINT = "oxlint@1.94.0";

const args = process.argv.slice(2);
const write = args.includes("--write");
const named = args.filter((arg) => arg !== "--write");
for (const arg of named) {
	if (arg.startsWith("--")) {
		console.error(`style: ${arg}: no option. Usage: node effect/scripts/style.ts [--write] [path ...]`);
		process.exit(1);
	}
}
const paths = named.length > 0 ? named : [...effectPackages().map((pkg) => pkg.directory), "effect"];
const sources = paths.map((path) => (statSync(join(ROOT, path)).isDirectory() ? `${path}/**/*.ts` : path));
const annotate = process.env.GITHUB_ACTIONS === "true";

const formatted = run(OXFMT, "oxfmt", ["-c", "effect/oxfmt.json", write ? "--write" : "--check", ...sources]);
const linted = run(OXLINT, "oxlint", [
	"-c",
	"effect/oxlint.json",
	"--deny-warnings",
	...(annotate ? ["--format=github"] : []),
	...paths,
]);
if (!formatted)
	console.error(`style: formatting differs; run: node effect/scripts/style.ts --write ${named.join(" ")}`);
process.exit(formatted && linted ? 0 : 1);

/** Runs `bin` of `pkg` through `npm exec` from the repository root; true when it exits 0. */
function run(pkg: string, bin: string, toolArgs: readonly string[]): boolean {
	const result = spawnSync("npm", ["exec", "--yes", `--package=${pkg}`, "--", bin, ...toolArgs], {
		cwd: ROOT,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, npm_config_loglevel: "error" },
	});
	return result.status === 0;
}
