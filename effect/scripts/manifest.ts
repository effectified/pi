// What a package manifest says once it leaves this repository, for the scripts that ship packages (`pack.ts`,
// `release.ts`, `vendor.ts`): the `source` condition points at `src`, which only this repository has, and a tarball
// is rewritten by unpacking it, editing its manifest and packing it again.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A manifest as untyped JSON: it is read from a file. */
export type Manifest = Record<string, unknown>;

/** `exports` without the `source` condition of each entry. */
export function withoutSource(exports: unknown): unknown {
	if (typeof exports !== "object" || exports === null) return exports;
	return Object.fromEntries(
		Object.entries(exports)
			.filter(([condition]) => condition !== "source")
			.map(([key, value]) => [key, withoutSource(value)]),
	);
}

/** Packs `tarball` again into `destination` with the manifest `edit` returns. The tarball itself is left as it is. */
export function repack(tarball: string, destination: string, edit: (manifest: Manifest) => Manifest): void {
	const staging = mkdtempSync(join(tmpdir(), "pi-effect-repack-"));
	run(tarball, "tar", ["-xzf", tarball, "-C", staging], staging);
	const manifestPath = join(staging, "package", "package.json");
	// Trust boundary: a manifest is a file, read as untyped JSON.
	const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	writeFileSync(manifestPath, `${JSON.stringify(edit(manifest), null, "\t")}\n`);
	run(tarball, "npm", ["pack", "--ignore-scripts", "--pack-destination", destination], join(staging, "package"));
	rmSync(staging, { recursive: true });
}

/**
 * Builds the package in `directory` from nothing. A build alone leaves the output of sources that are gone in `dist`,
 * and what leaves this repository would carry it.
 */
export function buildClean(name: string, directory: string): void {
	run(name, "npm", ["run", "clean"], directory);
	run(name, "npm", ["run", "build"], directory);
}

/** Runs `command` in `cwd` and ends the script when it fails; `name` says what the failure was about. */
export function run(name: string, command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
	if (result.status === 0) return;
	console.error(`${name}: ${command} ${args[0]} failed`);
	process.exit(result.status ?? 1);
}
