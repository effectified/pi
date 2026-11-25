// The checks and steps of a sync with upstream Pi (`effect/COMPAT.md`, "Bumping upstream"). `check` fails when the
// packages' Pi pins are not what the tree has; `bump` moves the pins to the merged Pi and runs the whole gate.
// Usage: node effect/scripts/sync.ts check [main] [--warn-unreleased]
//   One Pi version across all pins, equal to the workspace's; the wrapped Pi sources equal to what that version
//   released (its tag); the first row of COMPAT.md naming the pi-effect version, that Pi version and the upstream
//   commit (the merge base with `main`, default `main`, CI passes `origin/main`); the Pi version each package's
//   README opens with; `pi-surface.ts --check`.
//   `--warn-unreleased` reports Pi sources beyond the release, or a missing tag, without failing (CI).
// Usage: node effect/scripts/sync.ts bump [main]
//   After `git merge --no-commit --no-ff main`: pins every pi-effect manifest to the workspace's Pi version (and the
//   version each README opens with), takes the
//   lockfile from `main` and runs `npm install --ignore-scripts`, regenerates the surface record and prints what
//   changed, runs the gate one command at a time and stops at the first failure, then prints the new COMPAT.md row.
//   Upstream's whole `npm run check` only shows, as in effect-ci.yml; the parts of it that read the packages stop.
//   Left to a person: the merge, COMPAT.md's prose and row, the commit (`PI_ALLOW_LOCKFILE_CHANGE=1`), PatentOS's pins.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectPackages, ROOT } from "./packages.ts";
import {
	describeRelease,
	git,
	gitSucceeds,
	PI_SCOPE,
	PIN_FIELDS,
	piPins,
	readPins,
	releaseOf,
	workspacePiPackages,
} from "./pins.ts";

/** A command of the bump's gate: its failure stops the bump, or is shown and the gate goes on. */
interface GateStep {
	readonly kind: "stops" | "shows";
	readonly command: readonly [string, ...string[]];
}

/**
 * A Pi version named where a package's README says what it is built for: in its opening lines, after the name of a
 * Pi package. Further down a README states findings about a version ("Pi Durable 1.6.0 cannot delete …"), which stay.
 */
const BUILT_FOR = /\b(pi-ai|Pi Durable) (\d+\.\d+\.\d+)\b/g;

/** How many lines of a README are its opening. */
const OPENING_LINES = 30;

const [command, ...rest] = process.argv.slice(2);
const main = rest.find((arg) => !arg.startsWith("--")) ?? "main";
const started = performance.now();
if (command === "check") check(rest.includes("--warn-unreleased"));
else if (command === "bump") bump();
else {
	console.error("Usage: node effect/scripts/sync.ts check [main] [--warn-unreleased] | bump [main]");
	process.exit(1);
}

/** Runs every check of a synced tree, prints each result, and exits 1 when one fails. */
function check(warnUnreleased: boolean): void {
	const failures: string[] = [];
	const packages = effectPackages();
	const pins = readPins(packages);
	if (pins.kind === "broken") failures.push(...pins.failures);
	else {
		console.log(`pins: ${pins.count} pins of ${packages.length} manifests are Pi ${pins.version}, the workspace's.`);
		const release = releaseOf(pins.version, pins.wrapped);
		const wrapped = pins.wrapped.map((pkg) => pkg.name).join(", ");
		if (release.kind === "released") console.log(`release: ${wrapped} are what ${release.tag} released.`);
		else if (warnUnreleased) warn(describeRelease(release));
		else failures.push(...describeRelease(release));
		failures.push(...compatFailures(pins.version, packages));
		failures.push(...readmeFailures(pins.version));
	}
	console.log("surface: node effect/scripts/pi-surface.ts --check");
	const surface = spawnSync(process.execPath, [join(ROOT, "effect/scripts/pi-surface.ts"), "--check"], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (surface.status !== 0)
		failures.push("pi-surface.ts --check failed: the record is not what the tree gives (above)");
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	if (failures.length > 0) {
		console.error(`\nsync check failed (${seconds} s):`);
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log(`sync check passed (${seconds} s).`);
}

/** Prints lines as one warning, a GitHub annotation when run by GitHub Actions. */
function warn(lines: readonly string[]): void {
	if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=Pi release::${lines.join("%0A")}`);
	else for (const line of lines) console.log(`warning: ${line}`);
}

/**
 * What is wrong with the first row of COMPAT.md's version table: it must name the pi-effect version, `version` and
 * the upstream commit this branch is based on (its merge base with `main`).
 */
function compatFailures(version: string, packages: readonly { readonly version: string }[]): string[] {
	const ours = [...new Set(packages.map((pkg) => pkg.version))];
	if (ours.length !== 1) return [`the pi-effect packages do not share one version: ${ours.join(", ")}`];
	const lines = readFileSync(join(ROOT, "effect/COMPAT.md"), "utf8").split("\n");
	const header = lines.findIndex((line) => line.startsWith("| pi-effect |"));
	const row = header === -1 ? undefined : lines[header + 2];
	if (row === undefined || !row.startsWith("|")) return ["COMPAT.md has no version table (a header `| pi-effect |`)"];
	const cells = row.split("|").map((cell) => cell.trim());
	const commit = /`([0-9a-f]{7,40})`/.exec(cells[6] ?? "")?.[1];
	if (!gitSucceeds(["rev-parse", "-q", "--verify", `${main}^{commit}`])) {
		return [
			`${main} is not in this clone, so the upstream commit cannot be checked; name the upstream ref (CI: origin/main)`,
		];
	}
	const upstream = git(["merge-base", "HEAD", main]).trim();
	const failures: string[] = [];
	if (!cells[1].startsWith(ours[0]))
		failures.push(`COMPAT.md's first row is pi-effect ${cells[1]}, the packages are ${ours[0]}`);
	if (cells[2] !== version) failures.push(`COMPAT.md's first row names Pi ${cells[2]}, the pins ${version}`);
	if (commit === undefined || !upstream.startsWith(commit)) {
		failures.push(
			`COMPAT.md's first row names upstream ${cells[6]}, this branch is based on ${upstream.slice(0, 9)}`,
		);
	}
	if (failures.length === 0)
		console.log(`COMPAT.md: the first row names pi-effect ${ours[0]}, Pi ${version}, \`${commit}\`.`);
	return failures;
}

/** Moves the pins to the merged Pi version, installs, records the surface, runs the gate, prints the new row. */
function bump(): void {
	const upstream = git(["rev-parse", main]).trim();
	const merging = gitSucceeds(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
	const contained = (tip: string) => gitSucceeds(["merge-base", "--is-ancestor", upstream, tip]);
	if (!contained("HEAD") && !(merging && contained("MERGE_HEAD"))) {
		console.error(`sync bump: ${main} is not merged. First: git merge --no-commit --no-ff ${main}`);
		process.exit(1);
	}
	const version = workspaceVersion();
	console.log(`Pi ${version} at ${upstream.slice(0, 9)}.`);
	rewritePins(version);
	rewriteReadmes(version);
	console.log(`lockfile: package-lock.json from ${main}, then npm install --ignore-scripts`);
	writeFileSync(join(ROOT, "package-lock.json"), git(["show", `${main}:package-lock.json`]));
	const stops = (...command: [string, ...string[]]): GateStep => ({ kind: "stops", command });
	const packages = effectPackages().map((pkg) => pkg.directory);
	const steps: readonly GateStep[] = [
		stops("npm", "install", "--ignore-scripts"),
		stops(process.execPath, "effect/scripts/pi-surface.ts"),
		stops("npm", "run", "build"),
		// Upstream's whole check also fails on upstream's own tests when a model leaves the catalog its build fetched
		// that day. As in effect-ci.yml it shows; the parts of it that read the pi-effect packages stop the gate.
		{ kind: "shows", command: ["npm", "run", "check"] },
		stops("node_modules/.bin/biome", "check", ...packages, "effect", ".github/workflows/effect-ci.yml"),
		stops("npm", "run", "check:pinned-deps"),
		stops("npm", "run", "check:runtime-deps"),
		stops("npm", "run", "check:ts-imports"),
		stops(process.execPath, "effect/scripts/build.ts"),
		stops("node_modules/.bin/tsc", "--noEmit", "-p", "effect/tsconfig.json"),
		...packages.map((directory) => stops("npm", "run", "test", "--workspace", directory)),
		stops(process.execPath, "effect/scripts/test-bun.ts"),
		stops(process.execPath, "effect/scripts/check-deps.ts"),
	];
	const shownFailures: string[] = [];
	for (const [index, { kind, command }] of steps.entries()) {
		const [program, ...args] = command;
		const label = `[${index + 1}/${steps.length}] ${[program === process.execPath ? "node" : program, ...args].join(" ")}`;
		console.log(`\n${label}`);
		const stepStarted = performance.now();
		const result = spawnSync(program, args, { cwd: ROOT, stdio: "inherit" });
		const seconds = ((performance.now() - stepStarted) / 1000).toFixed(0);
		if (result.status === 0) console.log(`${label}: passed (${seconds} s)`);
		else if (kind === "shows") {
			shownFailures.push(`${label}: exit ${result.status}`);
			console.log(`${label}: failed (${seconds} s); shown, the gate goes on`);
		} else {
			console.error(`\nsync bump stopped at ${label}: exit ${result.status} (${seconds} s).`);
			console.error("Fix it and run `node effect/scripts/sync.ts bump` again.");
			process.exit(1);
		}
	}
	const minutes = ((performance.now() - started) / 60_000).toFixed(1);
	console.log(`\nThe gate passed (${minutes} min).`);
	for (const failure of shownFailures) {
		console.log(`Shown, not stopping: ${failure}. Read it: an error in an upstream file is upstream's own.`);
	}
	console.log("The new first row of effect/COMPAT.md, from measured values:\n");
	console.log(compatRow(version, upstream));
	console.log("\nLeft to you: COMPAT.md's row and prose, `node effect/scripts/sync.ts check`, the commit with");
	console.log("PI_ALLOW_LOCKFILE_CHANGE=1, and PatentOS's own Pi pins (effect/PATENTOS.md).");
}

/** The one version of the workspace's Pi packages the pi-effect packages pin; exits when they disagree. */
function workspaceVersion(): string {
	const pinned = new Set(piPins(effectPackages()).map((pin) => pin.name));
	const versions = new Map(
		workspacePiPackages()
			.filter((pkg) => pinned.has(pkg.name))
			.map((pkg) => [pkg.name, pkg.version]),
	);
	const distinct = [...new Set(versions.values())];
	if (distinct.length !== 1) {
		const found = [...versions].map(([name, found]) => `${name} ${found}`).join(", ");
		console.error(`sync bump: the pinned Pi packages of the workspace do not share one version: ${found}`);
		process.exit(1);
	}
	return distinct[0];
}

/** Sets every `@earendil-works/*` pin of every pi-effect manifest to `version`, written as `new-package.ts` writes. */
function rewritePins(version: string): void {
	let moved = 0;
	for (const pkg of effectPackages()) {
		const path = join(ROOT, pkg.directory, "package.json");
		const before = readFileSync(path, "utf8");
		// Trust boundary: a manifest is a file, read as untyped JSON.
		const manifest = JSON.parse(before);
		for (const field of PIN_FIELDS) {
			const specs: Record<string, string> | undefined = manifest[field];
			for (const name of Object.keys(specs ?? {})) {
				if (specs !== undefined && name.startsWith(PI_SCOPE) && specs[name] !== version) {
					specs[name] = version;
					moved++;
				}
			}
		}
		const after = `${JSON.stringify(manifest, null, "\t")}\n`;
		if (after !== before) writeFileSync(path, after);
	}
	console.log(`pins: ${moved === 0 ? "every pin is already" : `${moved} pins moved to`} Pi ${version}.`);
}

/** Each README whose opening names a Pi version other than `version`. */
function readmeFailures(version: string): string[] {
	const failures: string[] = [];
	for (const pkg of effectPackages()) {
		const opening = readFileSync(join(ROOT, pkg.directory, "README.md"), "utf8")
			.split("\n")
			.slice(0, OPENING_LINES);
		for (const [, name, found] of opening.join("\n").matchAll(BUILT_FOR)) {
			if (found !== version) {
				failures.push(`${pkg.directory}/README.md opens with ${name} ${found}, the pins are ${version}`);
			}
		}
	}
	if (failures.length === 0) console.log(`READMEs: none opens with another Pi version than ${version}.`);
	return failures;
}

/** Sets the Pi version each package's README opens with to `version`. */
function rewriteReadmes(version: string): void {
	let moved = 0;
	for (const pkg of effectPackages()) {
		const path = join(ROOT, pkg.directory, "README.md");
		const lines = readFileSync(path, "utf8").split("\n");
		const opening = lines.slice(0, OPENING_LINES).join("\n");
		const after = opening.replaceAll(BUILT_FOR, (_, name: string) => `${name} ${version}`);
		if (after !== opening) {
			writeFileSync(path, [after, ...lines.slice(OPENING_LINES)].join("\n"));
			moved++;
		}
	}
	console.log(`READMEs: ${moved === 0 ? "every opening already names" : `${moved} openings moved to`} Pi ${version}.`);
}

/** The new first row of COMPAT.md's version table, from the manifests, the lockfile and the installed runtimes. */
function compatRow(version: string, upstream: string): string {
	const packages = effectPackages();
	// Trust boundary: the lockfile is a file, read as untyped JSON.
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
	const effect = String(lock.packages?.["node_modules/effect"]?.version ?? "unknown");
	const peer = packages[0]?.peerDependencies.effect ?? "unknown";
	const output = (program: string) => spawnSync(program, ["--version"], { encoding: "utf8" }).stdout.trim();
	const node = output("node").replace(/^v/, "");
	const cells = [
		packages[0]?.version,
		version,
		`${effect} (peer \`${peer}\`)`,
		node,
		output("bun"),
		`\`${upstream.slice(0, 9)}\``,
	];
	return `| ${cells.join(" | ")} |`;
}
