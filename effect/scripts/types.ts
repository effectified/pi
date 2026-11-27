// The types and the Effect rules of the pi-effect packages in one Rust pass: the Effect-patched build of tsrs (the
// oxc project's Rust port of the TypeScript 7 compiler) that @effect/tsgo ships, on effect/tsconfig.json, whose
// plugin block makes the rules of effect/AGENTS.md errors. It is about four times as fast as `tsc` and
// `effect-tsgo diagnostics` run one after the other, and reports the same Effect findings.
// tsrs follows TypeScript 7.1; upstream pins 7.0.2 and checks its own files with it (`npm run check`). An error in an
// upstream file that our program reads through `paths` is listed and fails nothing: upstream does not import the
// packages, so no change of ours causes one. The tools are not dependencies (the root package.json is upstream's):
// `npm exec` fetches @effect/tsgo at the exact version below, with its tsrs build, into npm's cache.
// Usage: node effect/scripts/types.ts [--package <dir>]... [--summary]
//   --package <dir>  only the errors of packages/<dir> (repeatable), e.g. --package ai-effect
//   --summary        the errors counted by rule and by package instead of one line each
// Output: a type error as tsc prints it (`file(line,col): error TS1234: ...`, which effect/scripts/gate.ts reads to
// hold back the tests it can break), an Effect finding as `file:line:col <rule>: ...`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { effectPackages, ROOT } from "./packages.ts";

/** One diagnostic of tsrs: where, how severe, its code, and its rule when it is an Effect one. */
interface Diagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly severity: string;
	readonly code: number;
	readonly rule: string | undefined;
	readonly message: string;
}

/** How an Effect diagnostic's message ends: with the rule that reported it. */
const RULE = /\s*effect\((\w+)\)$/;

/** The exact @effect/tsgo and the build of tsrs it runs. */
export const TSGO = "@effect/tsgo@0.73.4";
const TSRS = "tsrs@7.1.0-beta.tsrs4";

const options = parseArgs({
	options: { package: { type: "string", multiple: true }, summary: { type: "boolean" } },
}).values;
const only = (options.package ?? []).map((dir) => `packages/${dir}/`);

const started = performance.now();
const args = ["exec", "--yes", `--package=${TSGO}`, "--", "effect-tsgo", TSRS];
const flags = ["--noEmit", "-p", "effect/tsconfig.json", "--pretty", "false", "--listFiles"];
const result = spawnSync("npm", [...args, ...flags], {
	cwd: ROOT,
	encoding: "utf8",
	maxBuffer: 256 * 1024 * 1024,
	env: { ...process.env, npm_config_loglevel: "error" },
});
const { diagnostics, listed, unread } = parse(result.stdout);
const seconds = ((performance.now() - started) / 1000).toFixed(1);
// tsrs checked the packages only when nothing cut it short and it read every file of ours: no signal ended it, it
// wrote nothing to stderr (a crash does), every line it printed is a diagnostic, part of one or a file it read (a
// fatal error names no file: `error TS18003: No inputs were found`), and no file of ours is missing from what it read
// (an `include` that lost a directory would check nothing there and pass).
const unchecked = ourFiles().filter((file) => !listed.has(file));
const broken = [
	...(result.error === undefined ? [] : [`it could not be started: ${result.error.message}`]),
	...(result.signal === null ? [] : [`${result.signal} ended it`]),
	...(result.stderr.trim() === "" ? [] : [`it wrote to stderr:\n${result.stderr.trim()}`]),
	...(unread.length === 0 ? [] : [`it printed what is no diagnostic of a file:\n${unread.join("\n")}`]),
	...(unchecked.length === 0
		? []
		: [`it did not read ${unchecked.length} files of ours, among them:\n${unchecked.slice(0, 10).join("\n")}`]),
];
if (broken.length > 0) {
	console.error(`types: tsrs did not check the packages (exit ${result.status}):\n${broken.join("\n")}`);
	process.exit(1);
}
if (result.status !== 0 && !diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
	console.error(`types: tsrs ended with exit ${result.status} and no diagnostic:\n${result.stdout}${result.stderr}`);
	process.exit(1);
}

// Ours: the packages and this directory. Everything else the program reads is upstream's.
const ours = (diagnostic: Diagnostic) => /^(packages\/[^/]+-effect|effect)\//.test(diagnostic.file);
const errors = diagnostics.filter(
	(diagnostic) =>
		diagnostic.severity === "error" &&
		ours(diagnostic) &&
		(only.length === 0 || only.some((prefix) => diagnostic.file.startsWith(prefix))),
);
const upstream = diagnostics.filter((diagnostic) => diagnostic.severity === "error" && !ours(diagnostic));

if (options.summary === true) {
	const count = (key: (diagnostic: Diagnostic) => string) => {
		const counts = new Map<string, number>();
		for (const error of errors) counts.set(key(error), (counts.get(key(error)) ?? 0) + 1);
		return [...counts].sort(([, a], [, b]) => b - a).map(([name, n]) => `  ${n} ${name}`);
	};
	console.log(`${errors.length} errors by rule:\n${count((error) => error.rule ?? `TS${error.code}`).join("\n")}`);
	console.log(`by package:\n${count((error) => error.file.split("/").slice(0, 2).join("/")).join("\n")}`);
	process.exit(errors.length > 0 ? 1 : 0);
}

for (const error of errors) {
	if (process.env.GITHUB_ACTIONS === "true") {
		console.log(
			`::error file=${error.file},line=${error.line},col=${error.column}::${error.rule ?? `TS${error.code}`}`,
		);
	}
	console.log(
		error.rule === undefined
			? `${error.file}(${error.line},${error.column}): error TS${error.code}: ${error.message}`
			: `${error.file}:${error.line}:${error.column} ${error.rule}: ${error.message}`,
	);
}
if (upstream.length > 0) {
	console.log(`\nNot failing, upstream's files under TypeScript 7.1 (upstream pins 7.0.2): ${upstream.length}`);
	for (const error of upstream)
		console.log(`  ${error.file}:${error.line}:${error.column} TS${error.code} ${error.message}`);
}
const others = new Map<string, number>();
for (const diagnostic of diagnostics) {
	if (diagnostic.severity === "error") continue;
	const key = `${diagnostic.severity} ${diagnostic.rule ?? `TS${diagnostic.code}`}`;
	others.set(key, (others.get(key) ?? 0) + 1);
}
if (others.size > 0) {
	const counted = [...others].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${n} ${key}`);
	console.log(`Not failing: ${counted.join(", ")}.`);
}
if (errors.length > 0) {
	console.error(`\nTypes and Effect rules: ${errors.length} errors (${seconds} s).`);
	process.exit(1);
}
console.log(`Types and Effect rules: no error (${seconds} s).`);

/** Every TypeScript file effect/tsconfig.json must include, relative to the root: the packages' and this directory's. */
function ourFiles(): string[] {
	const directories = [
		...effectPackages().flatMap((pkg) => [join(pkg.directory, "src"), join(pkg.directory, "test")]),
		"effect/scripts",
		"effect/spikes",
		"effect/idioms",
	];
	const found = directories.flatMap((directory) =>
		readdirSync(join(ROOT, directory), { recursive: true, encoding: "utf8" })
			.filter(
				(file) =>
					file.endsWith(".ts") && !file.split("/").some((part) => part === "dist" || part === "node_modules"),
			)
			.map((file) => join(directory, file)),
	);
	// The conformance helper every package's `test/pi-conformance.ts` uses, read through their imports.
	return [...found, "effect/conformance.ts"];
}

/**
 * tsrs's `--pretty false --listFiles` output read: its diagnostics of files, the files it read (absolute paths, after
 * the diagnostics), and every line that is none of these nor part of one. An Effect diagnostic's message may run over
 * several unindented lines and ends with `effect(<rule>)`; a TypeScript diagnostic's message chain is indented.
 */
function parse(output: string): {
	readonly diagnostics: Diagnostic[];
	readonly listed: ReadonlySet<string>;
	readonly unread: string[];
} {
	const start = /^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): (.*)$/;
	const raw: { match: RegExpExecArray; message: string }[] = [];
	const listed = new Set<string>();
	const unread: string[] = [];
	// The file list comes after every diagnostic: once it has begun, a line is a file or unread.
	let listing = false;
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const match = start.exec(line);
		const last = raw.at(-1);
		const effect = last !== undefined && last.match[5].startsWith("377");
		const openEffectMessage = effect && !RULE.test(last.message);
		const typeScriptChain = last !== undefined && !effect && /^\s/.test(line);
		if (isListedFile(line)) {
			listing = true;
			listed.add(line.startsWith(`${ROOT}/`) ? line.slice(ROOT.length + 1) : line);
		} else if (listing) unread.push(line);
		else if (match !== null) raw.push({ match, message: match[6] });
		else if (last !== undefined && (openEffectMessage || typeScriptChain)) last.message += ` ${line.trim()}`;
		else unread.push(line);
	}
	const diagnostics = raw.map(({ match, message }): Diagnostic => {
		const rule = RULE.exec(message);
		return {
			file: match[1].startsWith(ROOT) ? match[1].slice(ROOT.length + 1) : match[1],
			line: Number(match[2]),
			column: Number(match[3]),
			severity: match[4],
			code: Number(match[5]),
			rule: rule?.[1],
			message: rule === null ? message : message.slice(0, rule.index),
		};
	});
	return { diagnostics, listed, unread };
}

/** Whether `line` is a file tsrs lists as read: an absolute path, of a kind it reads, that exists. */
function isListedFile(line: string): boolean {
	return line.startsWith("/") && /\.(d\.)?[cm]?[jt]sx?$|\.json$/.test(line) && existsSync(line);
}
