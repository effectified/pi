// The pi-effect packages of this repository (`packages/*-effect`): their manifests, kinds and build order.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a package is (PRD section 5): a facade of one Pi package, a plugin on the facades, a host adapter, or a
 * composition, which composes the others as a product would: it may depend on all of them, and none on it.
 */
export type PackageKind = "facade" | "plugin" | "host" | "composition";

/** One pi-effect package as its `package.json` declares it. */
export interface EffectPackage {
	/** Path from the repository root, such as `packages/schema-effect`. */
	readonly directory: string;
	readonly name: string;
	readonly version: string;
	readonly kind: PackageKind;
	readonly dependencies: Readonly<Record<string, string>>;
	readonly peerDependencies: Readonly<Record<string, string>>;
	readonly devDependencies: Readonly<Record<string, string>>;
}

/** The repository root, two directories above this file. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every pi-effect package, sorted by directory. Throws when a manifest lacks a valid `piEffect.kind`. */
export function effectPackages(): EffectPackage[] {
	return readdirSync(join(ROOT, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.endsWith("-effect"))
		.map((entry) => `packages/${entry.name}`)
		.sort()
		.map((directory) => {
			// Trust boundary: a manifest is a file, read as untyped JSON.
			const manifest = JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8"));
			const kind: unknown = manifest.piEffect?.kind;
			if (kind !== "facade" && kind !== "plugin" && kind !== "host" && kind !== "composition") {
				const kinds = '"facade", "plugin", "host" or "composition"';
				throw new Error(`${directory}/package.json: piEffect.kind must be ${kinds}`);
			}
			return {
				directory,
				name: manifest.name,
				version: manifest.version,
				kind,
				dependencies: manifest.dependencies ?? {},
				peerDependencies: manifest.peerDependencies ?? {},
				devDependencies: manifest.devDependencies ?? {},
			};
		});
}

/**
 * `packages` with every package after the pi-effect packages it depends on at run time, or the names on a
 * dependency cycle when there is one.
 */
export function buildOrder(
	packages: readonly EffectPackage[],
):
	| { readonly kind: "ordered"; readonly packages: EffectPackage[] }
	| { readonly kind: "cycle"; readonly names: string[] } {
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	const ordered: EffectPackage[] = [];
	const placed = new Set<string>();
	let remaining = [...packages];
	while (remaining.length > 0) {
		const ready = remaining.filter((pkg) =>
			runtimeDependencies(pkg).every((name) => !byName.has(name) || placed.has(name)),
		);
		if (ready.length === 0) return { kind: "cycle", names: remaining.map((pkg) => pkg.name) };
		for (const pkg of ready) {
			ordered.push(pkg);
			placed.add(pkg.name);
		}
		remaining = remaining.filter((pkg) => !placed.has(pkg.name));
	}
	return { kind: "ordered", packages: ordered };
}

/** The names a package may import from its `src`: its dependencies and peer dependencies. */
export function runtimeDependencies(pkg: EffectPackage): string[] {
	return [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)];
}
