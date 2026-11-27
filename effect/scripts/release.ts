// Releases the pi-effect packages on npm. `effect-release.yml` runs it on every push to `effect`, after Effect CI
// passed on the commit: a version npm does not have yet is published, and nothing else happens on other pushes. So a
// release is a version change that is pushed (`version.ts`); no person signs in and no token is stored. npm takes
// the workflow's identity (trusted publishing), and each tarball gets a provenance attestation that names the commit.
// A release is never replaced, and a run that stopped half way is finished by the next: a package whose version is
// on npm already is left as it is. The tag `v<version>` and its GitHub release hold the notes, not the packages.
// Usage: node effect/scripts/release.ts plan
//   Says what `publish` would do: nothing (`released`), publish (`ready`), or that npm lacks a package (`bootstrap`:
//   a new package is made known to npm once by a person, `npm-bootstrap.ts`). In a workflow, sets the output `state`.
// Usage: node effect/scripts/release.ts publish [--dry-run]
//   Packs every package (`pack.ts`) and publishes those npm lacks at this version, in dependency order, then makes
//   the GitHub release. `--dry-run` packs and lets npm check each tarball, and publishes nothing.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./manifest.ts";
import { publicPackages, published, REPOSITORY, requireNpm } from "./npm.ts";
import { buildOrder, type EffectPackage, ROOT } from "./packages.ts";

/** What a release has to do, read from npm. */
type Plan =
	| { readonly kind: "released" }
	| { readonly kind: "ready"; readonly missing: readonly EffectPackage[] }
	| { readonly kind: "bootstrap"; readonly absent: readonly EffectPackage[] };

const [command, ...flags] = process.argv.slice(2);
const packages = publicPackages();
const version = sharedVersion();
const tag = `v${version}`;

if (command === "plan") await plan();
else if (command === "publish") await publish(flags.includes("--dry-run"));
else fail("Usage: node effect/scripts/release.ts plan | publish [--dry-run]");

/** The packages a run publishes: those npm lacks at this version, and all of them before npm knows any. */
function toPublish(found: Plan): readonly EffectPackage[] {
	switch (found.kind) {
		case "released":
			return [];
		case "ready":
			return found.missing;
		case "bootstrap":
			return packages;
	}
}

/** Prints what a release would do, and tells the workflow. */
async function plan(): Promise<void> {
	const found = await readPlan();
	switch (found.kind) {
		case "released":
			console.log(`${version} is on npm for all ${packages.length} packages: nothing to release.`);
			break;
		case "ready":
			console.log(`${version} is to be published for ${found.missing.map((pkg) => pkg.name).join(", ")}.`);
			break;
		case "bootstrap": {
			const lines = notBootstrapped(found.absent);
			for (const line of lines) console.log(line);
			if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=npm::${lines.join("%0A")}`);
		}
	}
	const output = process.env.GITHUB_OUTPUT;
	if (output !== undefined) appendFileSync(output, `state=${found.kind}\n`);
}

/** Publishes what npm lacks at this version and makes the GitHub release. */
async function publish(dryRun: boolean): Promise<void> {
	const found = await readPlan();
	// A dry run publishes nothing, so it also runs before npm knows the packages.
	if (found.kind === "bootstrap" && !dryRun) fail(notBootstrapped(found.absent).join("\n"));
	const missing = new Set(toPublish(found).map((pkg) => pkg.name));
	const head = git(["rev-parse", "HEAD"]).trim();
	// What is published names its commit: the tree is that commit, and the commit is on the remote.
	if (!dryRun) {
		if (git(["status", "--porcelain"]).trim() !== "") fail("the tree has uncommitted changes");
		git(["fetch", "--quiet", "origin"]);
		if (!git(["branch", "--remotes", "--contains", head]).includes("origin/")) fail(`HEAD ${head} is not pushed`);
	}

	const packed = mkdtempSync(join(tmpdir(), "pi-effect-packed-"));
	if (missing.size > 0) {
		// Trusted publishing came with npm 11.5.1: an older npm asks for a token.
		if (!dryRun) requireNpm([11, 5, 1], "publishing without a token");
		run("pack.ts", "node", [join(ROOT, "effect/scripts/pack.ts"), packed, ...unreleasedPi()], ROOT);
		for (const pkg of ordered()) {
			if (!missing.has(pkg.name)) continue;
			const publishing = spawnSync(
				"npm",
				[
					"publish",
					join(packed, tarballName(pkg.name)),
					"--access",
					"public",
					// npm gives a version without a tag the tag `latest`, which a version before its release must not take.
					"--tag",
					version.includes("-") ? "next" : "latest",
					...(dryRun ? ["--dry-run"] : []),
				],
				{ cwd: packed, stdio: "inherit" },
			);
			if (publishing.status !== 0) fail(`npm publish of ${pkg.name} failed; run the release again to go on from it`);
			console.log(`${dryRun ? "Checked" : "Published"} ${pkg.name}@${version}`);
		}
	}
	if (dryRun) return;
	if (spawnSync("gh", ["release", "view", tag, "--repo", REPOSITORY], { stdio: "ignore" }).status === 0) {
		console.log(`${tag} has its GitHub release already.`);
		return;
	}
	const notes = join(packed, "NOTES.md");
	writeFileSync(
		notes,
		releaseNotes(head, missing.size > 0 ? readFileSync(join(packed, "SOURCE.json"), "utf8") : undefined),
	);
	run(
		"gh release",
		"gh",
		[
			"release",
			"create",
			tag,
			"--repo",
			REPOSITORY,
			"--target",
			head,
			...(version.includes("-") ? ["--prerelease"] : []),
			"--title",
			`pi ${version}`,
			"--notes-file",
			notes,
		],
		ROOT,
	);
	console.log(`Released ${tag}: ${packages.length} packages on npm.`);
}

/** The one version the packages share; ends the script when they do not. */
function sharedVersion(): string {
	const versions = [...new Set(packages.map((pkg) => pkg.version))];
	const [shared] = versions;
	if (shared === undefined || versions.length !== 1) {
		fail(`the packages must share one version, they have: ${versions.join(", ")}`);
	}
	return shared;
}

/** What npm holds of the packages at this version. */
async function readPlan(): Promise<Plan> {
	const states = await Promise.all(packages.map(async (pkg) => ({ pkg, npm: await published(pkg.name) })));
	const absent = states.filter(({ npm }) => npm.kind === "absent").map(({ pkg }) => pkg);
	if (absent.length > 0) return { kind: "bootstrap", absent };
	const missing = states
		.filter(({ npm }) => npm.kind === "present" && !npm.versions.includes(version))
		.map(({ pkg }) => pkg);
	return missing.length === 0 ? { kind: "released" } : { kind: "ready", missing };
}

/** What to do about packages npm has never seen: it trusts a workflow only for a package that exists. */
function notBootstrapped(absent: readonly EffectPackage[]): string[] {
	return [
		`npm has no package named ${absent.map((pkg) => pkg.name).join(", ")}.`,
		"A workflow can publish only a package npm knows. Once, signed in to npm: node effect/scripts/npm-bootstrap.ts",
	];
}

/** The public packages, each after the pi-effect packages it depends on: npm never has one without the others. */
function ordered(): EffectPackage[] {
	const order = buildOrder(packages);
	if (order.kind === "cycle") fail(`dependency cycle among: ${order.names.join(", ")}`);
	return order.packages;
}

/**
 * `--unreleased-pi` for `pack.ts` when `effect/release.json` names this version: the packages are then built against
 * Pi sources their pinned version did not release, on purpose (`version.ts --unreleased-pi` writes it).
 */
function unreleasedPi(): string[] {
	// Trust boundary: a file, read as untyped JSON.
	const marker: unknown = JSON.parse(readFileSync(join(ROOT, "effect/release.json"), "utf8"));
	const named = typeof marker === "object" && marker !== null && "unreleasedPi" in marker && marker.unreleasedPi;
	return named === version ? ["--unreleased-pi"] : [];
}

/** The file `npm pack` writes for `name` at this version: `@effectified/pi-ai` is `effectified-pi-ai-0.2.0.tgz`. */
function tarballName(name: string): string {
	return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

/**
 * The release's notes: how to install, the packages on npm, and `source`, what `pack.ts` says they were built from.
 * A run that only adds the GitHub release to packages an earlier run published has packed nothing, and no `source`.
 */
function releaseNotes(head: string, source: string | undefined): string {
	const lines = packages.map((pkg) => `- [\`${pkg.name}\`](https://www.npmjs.com/package/${pkg.name}/v/${version})`);
	return [
		`The pi-effect packages ${version}, published on npm by CI from ${head}. Each tarball has a provenance`,
		"attestation that names this repository and that commit.",
		"",
		"```sh",
		"npm install @effectified/pi-thread effect",
		"```",
		"",
		...lines,
		"",
		...(source === undefined ? [] : ["Built from:", "", "```json", source.trim(), "```", ""]),
	].join("\n");
}

/** Runs git in the repository and returns its output; ends the script when git fails. */
function git(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	if (result.status !== 0) fail(`git ${args[0]} failed: ${result.stderr}`);
	return result.stdout;
}

/** Ends the script with `message`. */
function fail(message: string): never {
	console.error(`release.ts: ${message}`);
	process.exit(1);
}
