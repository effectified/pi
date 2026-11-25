// The Pi version the pi-effect packages pin, and whether the tree's Pi sources are what that version released. The
// pins are what a product installs beside the packages; the tree is what the packages were built and tested against.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type EffectPackage, effectPackages, ROOT } from "./packages.ts";

/** A Pi package of this workspace (`packages/<directory>`, named `@earendil-works/*`). */
export interface PiPackage {
	readonly name: string;
	/** Path from the repository root, such as `packages/durable`. */
	readonly directory: string;
	readonly version: string;
	/** The other Pi packages it depends on at run time. */
	readonly piDependencies: readonly string[];
}

/** The pins of the pi-effect packages: one Pi version the workspace has, or what breaks that. */
export type Pins =
	| {
			readonly kind: "pinned";
			readonly version: string;
			/** The pinned Pi packages and the Pi packages they depend on: what the packages are built against. */
			readonly wrapped: readonly PiPackage[];
			readonly count: number;
	  }
	| { readonly kind: "broken"; readonly failures: readonly string[] };

/** Whether the wrapped Pi sources in the tree are what the pinned version released (its tag, `v<version>`). */
export type Release =
	| { readonly kind: "released"; readonly tag: string }
	| {
			readonly kind: "unreleased";
			readonly tag: string;
			/** The `src` directories that differ from the tag. */
			readonly directories: readonly string[];
			/** The commits after the tag that changed them, `git log --oneline`. */
			readonly commits: readonly string[];
	  }
	| { readonly kind: "untagged"; readonly tag: string };

/** Upstream tags each release `v<version>`, as `git tag -l` shows (`v1.6.0`, `v1.6.1`). */
const TAG_PREFIX = "v";
/** The npm scope of Pi's packages. */
export const PI_SCOPE = "@earendil-works/";

/** Every Pi package of the workspace, sorted by directory. */
export function workspacePiPackages(): PiPackage[] {
	return readdirSync(join(ROOT, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.endsWith("-effect"))
		.map((entry) => `packages/${entry.name}`)
		.filter((directory) => existsSync(join(ROOT, directory, "package.json")))
		.sort()
		.flatMap((directory) => {
			// Trust boundary: a manifest is a file, read as untyped JSON.
			const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
			if (typeof manifest.name !== "string" || !manifest.name.startsWith(PI_SCOPE)) return [];
			const runtime = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
			const piDependencies = runtime.filter((name) => name.startsWith(PI_SCOPE));
			return [{ name: manifest.name, directory, version: String(manifest.version), piDependencies }];
		});
}

/** One `@earendil-works/*` pin of a pi-effect manifest. */
export interface Pin {
	/** The pi-effect package whose manifest holds the pin. */
	readonly owner: string;
	readonly name: string;
	readonly spec: string;
}

/** The manifest fields whose `@earendil-works/*` entries are pins. */
export const PIN_FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

/** Every `@earendil-works/*` pin of `packages`, in dependencies, devDependencies and peer dependencies. */
export function piPins(packages: readonly EffectPackage[]): Pin[] {
	return packages.flatMap((pkg) =>
		PIN_FIELDS.flatMap((field) =>
			Object.entries(pkg[field])
				.filter(([name]) => name.startsWith(PI_SCOPE))
				.map(([name, spec]) => ({ owner: pkg.name, name, spec })),
		),
	);
}

/**
 * The single Pi version of every pin of `packages` and the Pi packages it covers. Broken when the pins disagree, are
 * not exact, or are not the version of the workspace's Pi package they name.
 */
export function readPins(packages: readonly EffectPackage[]): Pins {
	const byVersion = new Map<string, string[]>();
	for (const pin of piPins(packages)) {
		byVersion.set(pin.spec, [...(byVersion.get(pin.spec) ?? []), `${pin.owner} ${pin.name}`]);
	}
	const [version, ...others] = [...byVersion.keys()];
	if (version === undefined) return { kind: "broken", failures: ["no pi-effect package pins a Pi package"] };
	if (others.length > 0) {
		const found = [...byVersion].map(([spec, pins]) => `${spec} (${pins.join(", ")})`).join("; ");
		return { kind: "broken", failures: [`more than one Pi version is pinned: ${found}`] };
	}
	if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
		return { kind: "broken", failures: [`the Pi pins are ${version}, not an exact version`] };
	}
	const workspace = new Map(workspacePiPackages().map((pkg) => [pkg.name, pkg]));
	const pinned = [...new Set((byVersion.get(version) ?? []).map((pin) => pin.split(" ")[1]))].sort();
	const failures: string[] = [];
	for (const name of pinned) {
		const found = workspace.get(name);
		if (found === undefined) failures.push(`${name} is pinned but is not a package of this workspace`);
		else if (found.version !== version) {
			failures.push(`the pins say Pi ${version}; the workspace's ${name} (${found.directory}) is ${found.version}`);
		}
	}
	if (failures.length > 0) return { kind: "broken", failures };
	const wrapped = new Map<string, PiPackage>();
	const add = (name: string): void => {
		const pkg = workspace.get(name);
		if (pkg === undefined || wrapped.has(name)) return;
		wrapped.set(name, pkg);
		for (const dependency of pkg.piDependencies) add(dependency);
	};
	for (const name of pinned) add(name);
	const count = byVersion.get(version)?.length ?? 0;
	return { kind: "pinned", version, wrapped: [...wrapped.values()].sort(byDirectory), count };
}

/**
 * Whether each wrapped package's `src` in the working tree equals its release tag. When one does not, the commits
 * after the tag that changed it, up to the merge in progress (`MERGE_HEAD`) or `HEAD`.
 */
export function releaseOf(version: string, wrapped: readonly PiPackage[]): Release {
	const tag = `${TAG_PREFIX}${version}`;
	if (!gitSucceeds(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`])) return { kind: "untagged", tag };
	const directories = wrapped
		.map((pkg) => `${pkg.directory}/src`)
		.filter((directory) => !gitSucceeds(["diff", "--quiet", tag, "--", directory]));
	if (directories.length === 0) return { kind: "released", tag };
	const tip = gitSucceeds(["rev-parse", "-q", "--verify", "MERGE_HEAD"]) ? "MERGE_HEAD" : "HEAD";
	const commits = git(["log", "--oneline", `${tag}..${tip}`, "--", ...directories])
		.split("\n")
		.filter((line) => line !== "");
	return { kind: "unreleased", tag, directories, commits };
}

/** What a release state means, in lines to print; none when the tree is the release. */
export function describeRelease(release: Release): string[] {
	switch (release.kind) {
		case "released":
			return [];
		case "untagged":
			return [
				`Cannot tell whether the Pi sources are what ${release.tag} released: the tag is not in this clone.`,
				"A shallow clone has no tags. Fetch upstream's tags (the push of a sync's main must push the tag too).",
			];
		case "unreleased":
			return [
				`The packages are built against Pi sources that ${release.tag} did not release: ${release.directories.join(", ")} differ.`,
				"A product installing the pinned version gets the released code, not this. Commits after the tag:",
				...release.commits.map((commit) => `  ${commit}`),
			];
	}
}

/**
 * The pins and release a build for a product (`pack.ts`, `vendor.ts`) rests on. Exits when the pins are broken, and
 * when the tree is not what the pinned version released unless `args` holds `--unreleased-pi`.
 */
export function productPins(
	script: string,
	args: readonly string[],
): { readonly version: string; readonly release: Release } {
	const pins = readPins(effectPackages());
	if (pins.kind === "broken") {
		console.error(`${script}: the Pi pins are not what is in the tree:`);
		for (const failure of pins.failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	const release = releaseOf(pins.version, pins.wrapped);
	if (release.kind === "released") return { version: pins.version, release };
	for (const line of describeRelease(release)) console.error(line);
	if (!args.includes("--unreleased-pi")) {
		console.error(`${script}: refusing to build. Pass --unreleased-pi to build against unreleased Pi on purpose;`);
		console.error("SOURCE.json beside the output then says so.");
		process.exit(1);
	}
	console.error(`${script}: building against unreleased Pi (--unreleased-pi); SOURCE.json says so.`);
	return { version: pins.version, release };
}

/** What `SOURCE.json` beside a product's copy of the packages says they were built from. */
export function sourceRecord(version: string, release: Release): Record<string, unknown> {
	const pi =
		release.kind === "unreleased"
			? { version, built: "unreleased", tag: release.tag, commits: release.commits }
			: { version, built: release.kind === "released" ? "released" : "unverified", tag: release.tag };
	return {
		commit: git(["rev-parse", "HEAD"]).trim(),
		uncommitted: git(["status", "--porcelain", "--", "packages", "effect"]).trim() !== "",
		pi,
	};
}

/** `git` in the repository root; throws when it fails. */
export function git(args: readonly string[]): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Whether `git` in the repository root exits 0; its output is discarded. */
export function gitSucceeds(args: readonly string[]): boolean {
	return spawnSync("git", args, { cwd: ROOT, stdio: "ignore" }).status === 0;
}

function byDirectory(a: PiPackage, b: PiPackage): number {
	return a.directory.localeCompare(b.directory);
}
