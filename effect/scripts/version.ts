// Moves the one version the pi-effect packages share, everywhere it is written: every manifest, each dependency of
// one package on another, the first row and the package table's heading of `effect/COMPAT.md`, `effect/release.json`
// and the lockfile. The commit that holds the result is the release: once it is pushed and Effect CI passed on it,
// `effect-release.yml` publishes the version on npm (`release.ts`).
// Usage: node effect/scripts/version.ts <major|minor|patch|x.y.z[-pre]> [--unreleased-pi]
//   `--unreleased-pi` lets this one version be built against Pi sources its pinned Pi version did not release
//   (upstream's `main` past the tag): `release.ts` passes it to `pack.ts`, and the release notes say so.
// Left to a person: the gate, the prose of COMPAT.md for the new row, and the commit (`PI_ALLOW_LOCKFILE_CHANGE=1`).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./manifest.ts";
import { effectPackages, ROOT } from "./packages.ts";
import { PIN_FIELDS } from "./pins.ts";

/** The npm scope of the pi-effect packages. */
const SCOPE = "@effectified/";

const args = process.argv.slice(2);
const [step] = args.filter((arg) => !arg.startsWith("--"));
const packages = effectPackages();
const versions = [...new Set(packages.map((pkg) => pkg.version))];
const [current] = versions;
if (current === undefined || versions.length !== 1) {
	fail(`the packages do not share one version: ${versions.join(", ")}`);
}
const next = step === undefined ? undefined : nextVersion(current, step);
if (next === undefined || next === current) {
	fail(`Usage: node effect/scripts/version.ts <major|minor|patch|x.y.z[-pre]> [--unreleased-pi] (now ${current})`);
}

for (const pkg of packages) {
	const path = join(ROOT, pkg.directory, "package.json");
	// Trust boundary: a manifest is a file, read as untyped JSON.
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	manifest.version = next;
	for (const field of PIN_FIELDS) {
		const specs: Record<string, string> | undefined = manifest[field];
		for (const name of Object.keys(specs ?? {})) {
			if (specs !== undefined && name.startsWith(SCOPE) && specs[name] === current) specs[name] = next;
		}
	}
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}
console.log(`manifests: ${packages.length} packages moved from ${current} to ${next}.`);

writeCompat(current, next);
const marker = { unreleasedPi: args.includes("--unreleased-pi") ? next : null };
writeFileSync(join(ROOT, "effect/release.json"), `${JSON.stringify(marker, null, "\t")}\n`);
run("lockfile", "npm", ["install", "--package-lock-only", "--ignore-scripts"], ROOT);
console.log("lockfile: package-lock.json names the new version.");
console.log("\nLeft to you: `node effect/scripts/gate.ts`, COMPAT.md's prose for the new row, and the commit with");
console.log("PI_ALLOW_LOCKFILE_CHANGE=1. Once it is pushed and Effect CI passed, effect-release.yml publishes it.");

/** `from` moved by `step`, or `step` itself when it is a version; nothing when it is neither. */
function nextVersion(from: string, step: string): string | undefined {
	if (/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(step)) return step;
	const [major = 0, minor = 0, patch = 0] = from.split("-")[0]?.split(".").map(Number) ?? [];
	switch (step) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		default:
			return undefined;
	}
}

/**
 * Gives COMPAT.md a first row for `to`, with the upstream versions of the row of `from`, and names `to` in the
 * heading of the package table. The row says what the release was tested on: whoever runs the gate corrects a cell
 * that changed (`sync.ts check` holds the Pi version and the upstream commit to the tree).
 */
function writeCompat(from: string, to: string): void {
	const path = join(ROOT, "effect/COMPAT.md");
	const lines = readFileSync(path, "utf8").split("\n");
	const first = lines.findIndex((line) => line.startsWith("| pi-effect |")) + 2;
	const row = lines[first];
	if (first === 1 || row === undefined || !row.startsWith(`| ${from} |`)) {
		fail(`COMPAT.md's version table does not start with a row for ${from}`);
	}
	lines.splice(first, 0, row.replace(`| ${from} |`, `| ${to} |`));
	const heading = lines.indexOf(`## Packages in ${from}`);
	if (heading !== -1) lines[heading] = `## Packages in ${to}`;
	writeFileSync(path, lines.join("\n"));
	console.log(`COMPAT.md: a first row for ${to}, with the upstream versions of ${from}'s.`);
}

/** Ends the script with `message`. */
function fail(message: string): never {
	console.error(`version.ts: ${message}`);
	process.exit(1);
}
