// Makes the pi-effect packages known to npm, once, so that `effect-release.yml` can publish them from then on with
// no token. npm trusts a workflow only for a package that exists, so each package npm lacks gets a placeholder
// version `0.0.0` (a manifest and a README, no code), and each package gets its trusted publisher: this repository
// and that workflow. The first real version is published by the workflow, which this script starts when it ends.
// Run it again for a new package: what is done is skipped.
// It needs a person signed in to npm (`npm login`) with two-factor authentication on, who approves the first request
// in the browser; npm's page offers to ask no more for five minutes, which is enough for every package.
// Usage: node effect/scripts/npm-bootstrap.ts [--dry-run]
//   `--dry-run` lets npm check each placeholder, and publishes and sets nothing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BRANCH, publicPackages, published, REPOSITORY, requireNpm, WORKFLOW } from "./npm.ts";

/** The version of a placeholder: below every real one, so it is never `latest` once a release exists. */
const PLACEHOLDER = "0.0.0";

const dryRun = process.argv.includes("--dry-run");
const names = publicPackages().map((pkg) => pkg.name);

// `npm trust` came with npm 11.15.0.
requireNpm([11, 15, 0], "setting a trusted publisher");
if (!dryRun && spawnSync("npm", ["whoami"], { stdio: "ignore" }).status !== 0) {
	console.error("npm-bootstrap.ts: not signed in to npm. Run `npm login`, then this script again.");
	process.exit(1);
}

let placed = 0;
let trusted = 0;
for (const name of names) {
	if ((await published(name)).kind === "absent") {
		npm(["publish", placeholder(name), "--access", "public", ...(dryRun ? ["--dry-run"] : [])], `publish ${name}`);
		placed++;
	}
	if (dryRun) continue;
	// A package has one trusted publisher: one that names this workflow already is kept.
	const listed = spawnSync("npm", ["trust", "list", name, "--json"], { encoding: "utf8" });
	if (listed.status === 0 && listed.stdout.includes(WORKFLOW)) continue;
	npm(
		["trust", "github", name, "--file", WORKFLOW, "--repository", REPOSITORY, "--allow-publish", "--yes"],
		`trust ${WORKFLOW} for ${name}`,
	);
	trusted++;
	// npm limits how fast trust is set: its documentation asks for two seconds between requests.
	await sleep(2000);
}
console.log(
	`${names.length} packages: ${placed} placeholders ${dryRun ? "checked" : "published"}, ${trusted} trusted publishers set.`,
);
if (!dryRun && trusted > 0) {
	// npm drops a trusted publisher that has not published within two days, so the first release starts now.
	const start = ["workflow", "run", WORKFLOW, "--repo", REPOSITORY, "--ref", BRANCH];
	console.log(
		spawnSync("gh", start, { stdio: "inherit" }).status === 0
			? `Started ${WORKFLOW}: it publishes the version npm lacks.`
			: `Start the release within two days, or npm drops the trust: gh ${start.join(" ")}`,
	);
}

/** A directory that holds the placeholder of `name`: what `npm publish` is given. */
function placeholder(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), "npm-placeholder-"));
	const manifest = {
		name,
		version: PLACEHOLDER,
		description: `Placeholder: ${name} is published from https://github.com/${REPOSITORY}`,
		license: "MIT",
		// npm compares this with the workflow's repository when the workflow publishes.
		repository: { type: "git", url: `git+https://github.com/${REPOSITORY}.git` },
	};
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(
		join(directory, "README.md"),
		`# ${name}\n\nThis version holds no code. It makes the name known to npm, so that the workflow of https://github.com/${REPOSITORY} can publish the package. Install a later version.\n`,
	);
	return directory;
}

/** Runs npm with the terminal, so that it can ask the person to approve; ends the script when it fails. */
function npm(command: string[], what: string): void {
	if (spawnSync("npm", command, { stdio: "inherit" }).status === 0) return;
	console.error(`npm-bootstrap.ts: could not ${what}. What was done before is kept: run the script again.`);
	process.exit(1);
}
