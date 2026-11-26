// Releases the pi-effect packages on GitHub instead of npm: the tarballs of `pack.ts`, attached to the prerelease
// `v<version>` of effectified/pi, where each package's dependencies on the others name their tarballs' release URLs.
// So installing the release URL of one tarball (npm, pnpm or Bun) installs it with every pi-effect package it needs,
// and Pi and `effect` from npm. A release is made from a clean tree whose HEAD is pushed, and never replaced: a new
// release needs a new version (`node effect/scripts/sync.ts bump` moves Pi; the packages' own version moves by hand).
// Usage: node effect/scripts/release.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest, repack, run } from "./manifest.ts";
import { effectPackages, ROOT } from "./packages.ts";

const REPOSITORY = "effectified/pi";
const SCOPE = "@effectified/";

const versions = new Set(effectPackages().map((pkg) => pkg.version));
const [version] = versions;
if (version === undefined || versions.size !== 1) {
	fail(`the packages must share one version, they have: ${[...versions].join(", ")}`);
}
const tag = `v${version}`;
const base = `https://github.com/${REPOSITORY}/releases/download/${tag}`;

if (git(["status", "--porcelain"]).trim() !== "") fail("the tree has uncommitted changes");
const head = git(["rev-parse", "HEAD"]).trim();
git(["fetch", "--quiet", "origin"]);
if (!git(["branch", "--remotes", "--contains", head]).includes("origin/")) fail(`HEAD ${head} is not pushed`);
if (spawnSync("gh", ["release", "view", tag, "--repo", REPOSITORY], { stdio: "ignore" }).status === 0) {
	fail(`${tag} is released already; a release is never replaced, move the version`);
}

const packed = mkdtempSync(join(tmpdir(), "pi-effect-packed-"));
run("pack.ts", "node", [join(ROOT, "effect/scripts/pack.ts"), packed], ROOT);
const released = mkdtempSync(join(tmpdir(), "pi-effect-release-"));
for (const tarball of readdirSync(packed).filter((file) => file.endsWith(".tgz"))) {
	repack(join(packed, tarball), released, withReleaseDependencies);
}
const tarballs = readdirSync(released).filter((file) => file.endsWith(".tgz"));

const notes = join(released, "NOTES.md");
writeFileSync(notes, releaseNotes(tarballs, readFileSync(join(packed, "SOURCE.json"), "utf8")));
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
		"--prerelease",
		"--title",
		`pi ${version}`,
		"--notes-file",
		notes,
		...tarballs.map((file) => join(released, file)),
	],
	ROOT,
);
console.log(`Released ${tag}: ${tarballs.length} tarballs at ${base}`);

/** The manifest with each dependency on a pi-effect package pointing at that package's tarball in this release. */
function withReleaseDependencies(manifest: Manifest): Manifest {
	// The manifest was written by `npm pack` from one of ours: `dependencies` maps names to specs.
	const dependencies = Object.entries((manifest.dependencies ?? {}) as Record<string, string>).map(([name, spec]) => [
		name,
		name.startsWith(SCOPE) ? `${base}/${tarballName(name)}` : spec,
	]);
	return { ...manifest, dependencies: Object.fromEntries(dependencies) };
}

/** The file `npm pack` writes for `name` at this version: `@effectified/pi-ai` is `effectified-pi-ai-0.1.0.tgz`. */
function tarballName(name: string): string {
	return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

/** The release's notes: how to install a package from it, its tarballs, and what they were built from. */
function releaseNotes(files: string[], source: string): string {
	const lines = files.sort().map((file) => `- ${base}/${file}`);
	return [
		`The pi-effect packages ${version}, built at ${head}. Install one from its tarball URL; the pi-effect packages`,
		"it depends on come from this release, Pi and `effect` from npm:",
		"",
		"```sh",
		`npm install --allow-remote=all ${base}/effectified-pi-ai-${version}.tgz @earendil-works/pi-ai effect`,
		`pnpm add --config.block-exotic-subdeps=false ${base}/effectified-pi-ai-${version}.tgz @earendil-works/pi-ai effect`,
		`bun add ${base}/effectified-pi-ai-${version}.tgz @earendil-works/pi-ai effect`,
		"```",
		"",
		"npm 12 fetches no URL dependencies unless `--allow-remote=all` (or `allow-remote=all` in `.npmrc`) allows them,",
		"and pnpm none below the top level unless `blockExoticSubdeps` is off; Bun needs neither.",
		"",
		...lines,
		"",
		"Built from:",
		"",
		"```json",
		source.trim(),
		"```",
		"",
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
