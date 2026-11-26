// The gate of the pi-effect packages in one command: what CI's `boundary` and `check` jobs judge, run here, with one
// line per step and the end of a failed step's output. It changes no file (upstream's `npm run check` rewrites every
// file Biome would format, other agents' unfinished ones too). The whole output of each step is kept in a directory
// the first line names. Tests need upstream's `npm run build` to have run once (Pi's `dist`).
// Usage: node effect/scripts/gate.ts [--changed[=<ref>]] [--skip=<step>[,<step>]] [package directory name ...]
//   No package named: every package's tests. Packages named: theirs alone.
//   --changed          tests of the packages with uncommitted changes and of every package that depends on one;
//                      a change under effect/ or to the lockfile selects all. With =<ref>, also what changed since it.
//   --skip             leaves steps out by name: biome, pinned-deps, runtime-deps, ts-imports, types, diagnostics,
//                      sync, boundary, deps, node, bun.
// The checks all run, so one run names everything that is wrong. The tests run one package at a time, and not for a
// package with a type error, nor for one that depends on a package with a type error in its `src`: another agent's
// half-written file stops the tests it can break and no others. Exit 1 when a step failed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EffectPackage, effectPackages, ROOT } from "./packages.ts";

/** One command of the gate, and what its output says of tests when it is a suite. */
interface Step {
	readonly name: string;
	readonly label: string;
	readonly command: readonly [string, ...string[]];
	readonly cwd: string;
	/** The package a suite tests. */
	readonly pkg?: EffectPackage;
	readonly counts?: (output: string) => Counts | undefined;
}

/** How many tests of a suite passed, failed and were skipped. */
interface Counts {
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
}

/** What became of a step. */
type Outcome =
	| { readonly kind: "passed"; readonly seconds: number; readonly counts: Counts | undefined }
	| { readonly kind: "failed"; readonly seconds: number; readonly counts: Counts | undefined; readonly log: string }
	| { readonly kind: "not run"; readonly why: string };

const STEP_NAMES = [
	"biome",
	"pinned-deps",
	"runtime-deps",
	"ts-imports",
	"types",
	"diagnostics",
	"sync",
	"boundary",
	"deps",
	"node",
	"bun",
];

const NO_COUNTS: Counts = { passed: 0, failed: 0, skipped: 0 };

const leftOut: Outcome = { kind: "not run", why: "left out with --skip" };

/** How many lines of a failed step's output are printed. */
const TAIL_LINES = 30;

const args = process.argv.slice(2);
const skipped = new Set(
	args.filter((arg) => arg.startsWith("--skip=")).flatMap((arg) => arg.slice("--skip=".length).split(",")),
);
const changedSince = args.find((arg) => arg === "--changed" || arg.startsWith("--changed="));
const named = args.filter((arg) => !arg.startsWith("--"));
const packages = effectPackages();
const failures: string[] = [];
for (const name of skipped) if (!STEP_NAMES.includes(name)) failures.push(`--skip=${name}: no step has that name`);
for (const name of named) {
	if (!packages.some((pkg) => pkg.directory === `packages/${name}`)) failures.push(`${name}: no pi-effect package`);
}
for (const arg of args) {
	if (arg.startsWith("--") && arg !== changedSince && !arg.startsWith("--skip=")) failures.push(`${arg}: no option`);
}
if (failures.length > 0) {
	console.error(`gate: ${failures.join("; ")}`);
	console.error("Usage: node effect/scripts/gate.ts [--changed[=<ref>]] [--skip=<step>[,<step>]] [package ...]");
	process.exit(1);
}

const started = performance.now();
const logs = mkdtempSync(join(tmpdir(), "pi-effect-gate-"));
const tested = selected();
console.log(`gate: the whole output of each step is in ${logs}`);
console.log(`gate: tests of ${tested.what}`);

const directories = packages.map((pkg) => pkg.directory);
const node = process.execPath;
const check = (name: string, label: string, ...command: [string, ...string[]]): Step => ({
	name,
	label,
	command,
	cwd: ROOT,
});
const checks: readonly Step[] = [
	// `effect/biome.json` brings this directory under upstream's rules, which leave it out.
	check("biome", "format and lint", "node_modules/.bin/biome", "check", ...directories, "effect"),
	check("pinned-deps", "pinned versions", "npm", "run", "check:pinned-deps"),
	check("runtime-deps", "declared runtime dependencies", "npm", "run", "check:runtime-deps"),
	check("ts-imports", "import style", "npm", "run", "check:ts-imports"),
	check("types", "types", "node_modules/.bin/tsc", "--noEmit", "-p", "effect/tsconfig.json"),
	check("diagnostics", "Effect diagnostics", node, "effect/scripts/effect-diagnostics.ts"),
	check("sync", "Pi pins, release and surface record", node, "effect/scripts/sync.ts", "check"),
	check("boundary", "fork boundary", node, "effect/scripts/check-boundary.ts"),
	check("deps", "dependency rules", node, "effect/scripts/check-deps.ts"),
];
const suites: readonly Step[] = [
	...tested.packages.map(
		(pkg): Step => ({
			name: "node",
			label: `${shortName(pkg)} on Node`,
			command: [node, join(ROOT, "node_modules/vitest/dist/cli.js"), "--run"],
			cwd: join(ROOT, pkg.directory),
			pkg,
			counts: vitestCounts,
		}),
	),
	...tested.packages.map(
		(pkg): Step => ({
			name: "bun",
			label: `${shortName(pkg)} on Bun`,
			command: [node, "effect/scripts/test-bun.ts", shortName(pkg)],
			cwd: ROOT,
			pkg,
			counts: bunCounts,
		}),
	),
];

const outcomes: Array<readonly [Step, Outcome]> = [];
for (const step of checks) outcomes.push([step, skipped.has(step.name) ? leftOut : run(step)]);
const untyped = withoutTypes(outcomes.find(([step]) => step.name === "types")?.[1]);
for (const step of suites) {
	const outcome: Outcome = skipped.has(step.name)
		? leftOut
		: step.pkg !== undefined && untyped.packages.has(step.pkg.name)
			? { kind: "not run", why: untyped.why }
			: run(step);
	outcomes.push([step, outcome]);
}

const failed = outcomes.filter(([, outcome]) => outcome.kind === "failed");
const notRun = outcomes.filter(([, outcome]) => outcome.kind === "not run");
const minutes = ((performance.now() - started) / 60_000).toFixed(1);
console.log("");
for (const lane of ["node", "bun"]) {
	const ran = outcomes.filter(([step, outcome]) => step.name === lane && outcome.kind !== "not run");
	if (ran.length === 0) continue;
	const total = (pick: (counts: Counts) => number) =>
		ran.reduce((sum, [, outcome]) => sum + (outcome.kind === "not run" ? 0 : pick(outcome.counts ?? NO_COUNTS)), 0);
	const skippedTests = total((counts) => counts.skipped);
	console.log(
		`${lane === "node" ? "Node" : "Bun"}: ${total((counts) => counts.passed)} passed, ${total((counts) => counts.failed)} failed` +
			`${skippedTests > 0 ? `, ${skippedTests} skipped` : ""} in ${ran.length} packages.`,
	);
}
if (notRun.length > 0) {
	// By reason, so that the line says which suites a type error held back.
	const reasons = new Map<string, string[]>();
	for (const [step, outcome] of notRun) {
		const why = whyOf(outcome);
		reasons.set(why, [...(reasons.get(why) ?? []), step.pkg === undefined ? step.name : step.label]);
	}
	for (const [why, names] of reasons) console.log(`Not run, ${why}: ${names.join(", ")}.`);
}
if (failed.length > 0) {
	console.error(`The gate failed (${minutes} min): ${failed.map(([step]) => step.label).join("; ")}.`);
	process.exit(1);
}
console.log(`The gate passed (${minutes} min).`);

/** Runs a step, prints its line, and for a failure the end of what it wrote. */
function run(step: Step): Outcome {
	const stepStarted = performance.now();
	const result = spawnSync(step.command[0], step.command.slice(1), {
		cwd: step.cwd,
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
		// Plain text, so that the counts can be read and the kept output is readable.
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const log = join(logs, `${step.label.replaceAll(/[^A-Za-z0-9]+/g, "-")}.log`);
	writeFileSync(log, output);
	const seconds = (performance.now() - stepStarted) / 1000;
	const counts = step.counts?.(output);
	const said =
		counts === undefined ? "" : `, ${counts.passed} passed${counts.failed > 0 ? `, ${counts.failed} failed` : ""}`;
	if (result.status === 0) {
		console.log(`ok    ${step.label} (${seconds.toFixed(1)} s${said})`);
		return { kind: "passed", seconds, counts };
	}
	console.log(`FAIL  ${step.label} (${seconds.toFixed(1)} s${said}): ${log}`);
	console.log(indented(lastLines(output)));
	return { kind: "failed", seconds, counts, log };
}

/**
 * The packages whose tests cannot be trusted after the types step, by name, and why in words: those with a type
 * error, and those that depend on a package with one in its `src` (an error in a test breaks no other package). All
 * of them when an error is outside the packages or cannot be placed.
 */
function withoutTypes(types: Outcome | undefined): { readonly packages: ReadonlySet<string>; readonly why: string } {
	if (types?.kind !== "failed") return { packages: new Set(), why: "" };
	const errors = readFileSync(types.log, "utf8")
		.split("\n")
		.filter((line) => /\berror TS\d+/.test(line));
	const broken = packages.filter((pkg) => errors.some((line) => line.startsWith(`${pkg.directory}/`)));
	const placed = errors.every((line) => packages.some((pkg) => line.startsWith(`${pkg.directory}/`)));
	if (broken.length === 0 || !placed) {
		return { packages: new Set(packages.map((pkg) => pkg.name)), why: "the types do not hold" };
	}
	const inSource = broken.filter((pkg) => errors.some((line) => line.startsWith(`${pkg.directory}/src/`)));
	return {
		packages: new Set([...broken, ...withDependents(inSource)].map((pkg) => pkg.name)),
		why: `type errors in ${broken.map(shortName).join(", ")}`,
	};
}

/** The packages whose tests run, and how that was decided, in words. */
function selected(): { readonly packages: readonly EffectPackage[]; readonly what: string } {
	if (named.length > 0) {
		const chosen = packages.filter((pkg) => named.includes(shortName(pkg)));
		return { packages: chosen, what: chosen.map(shortName).join(", ") };
	}
	if (changedSince === undefined) return { packages, what: `all ${packages.length} packages` };
	const ref = changedSince.includes("=") ? changedSince.slice(changedSince.indexOf("=") + 1) : undefined;
	const files = changedFiles(ref);
	const since = ref === undefined ? "uncommitted changes" : `changes since ${ref}`;
	if (files.some((file) => file.startsWith("effect/") || file === "package-lock.json")) {
		return { packages, what: `all ${packages.length} packages (${since} reach effect/ or the lockfile)` };
	}
	const touched = packages.filter((pkg) => files.some((file) => file.startsWith(`${pkg.directory}/`)));
	// A docs package is built from every other package's README and manifest: a change to any of them is its too.
	const chosen = withDependents(
		touched.length === 0 ? [] : [...touched, ...packages.filter((pkg) => pkg.kind === "docs")],
	);
	if (chosen.length === 0) return { packages: [], what: `no package (no ${since} in a package)` };
	return { packages: chosen, what: `${chosen.map(shortName).join(", ")} (${since}, with what depends on them)` };
}

/** The paths that differ from the last commit, untracked ones included, and with `ref` those changed since it. */
function changedFiles(ref: string | undefined): string[] {
	const git = (...command: string[]) => {
		const result = spawnSync("git", command, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		if (result.status !== 0) {
			console.error(`gate: git ${command.join(" ")} failed: ${result.stderr.trim()}`);
			process.exit(1);
		}
		return result.stdout.split("\0").filter((path) => path !== "");
	};
	return [
		...git("diff", "--name-only", "-z", "HEAD"),
		...git("ls-files", "--others", "--exclude-standard", "-z"),
		...(ref === undefined ? [] : git("diff", "--name-only", "-z", `${ref}...HEAD`)),
	];
}

/** `touched` and every package that depends on one of them, at run time or in its tests, through any number of others. */
function withDependents(touched: readonly EffectPackage[]): EffectPackage[] {
	const chosen = new Set(touched.map((pkg) => pkg.name));
	for (let grew = true; grew; ) {
		grew = false;
		for (const pkg of packages) {
			const uses = [pkg.dependencies, pkg.peerDependencies, pkg.devDependencies].flatMap((specs) =>
				Object.keys(specs),
			);
			if (!chosen.has(pkg.name) && uses.some((name) => chosen.has(name))) {
				chosen.add(pkg.name);
				grew = true;
			}
		}
	}
	return packages.filter((pkg) => chosen.has(pkg.name));
}

/** A package's directory name, which is what the scripts take as its name: `schema-effect`. */
function shortName(pkg: EffectPackage): string {
	return pkg.directory.slice("packages/".length);
}

/** The counts of Vitest's summary line: `Tests  2 failed | 189 passed | 1 skipped (192)`. */
function vitestCounts(output: string): Counts | undefined {
	const line = output.split("\n").findLast((candidate) => /^\s*Tests\s/.test(candidate));
	if (line === undefined) return undefined;
	const count = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
	return { passed: count("passed"), failed: count("failed"), skipped: count("skipped") };
}

/** The counts of `bun test`'s summary lines: ` 188 pass`, ` 4 skip`, ` 0 fail`. */
function bunCounts(output: string): Counts | undefined {
	const count = (word: string) => new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(output)?.[1];
	const passed = count("pass");
	return passed === undefined
		? undefined
		: { passed: Number(passed), failed: Number(count("fail") ?? 0), skipped: Number(count("skip") ?? 0) };
}

function whyOf(outcome: Outcome): string {
	return outcome.kind === "not run" ? outcome.why : "";
}

/** The last lines of a step's output that say something, without the engine's own log lines. */
function lastLines(output: string): string {
	const lines = output.split("\n").filter((line) => line.trim() !== "" && !/^(level=|ts=)/.test(line));
	return lines
		.slice(-TAIL_LINES)
		.map((line) => (line.length > 240 ? `${line.slice(0, 240)} …` : line))
		.join("\n");
}

function indented(text: string): string {
	return text
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n");
}
