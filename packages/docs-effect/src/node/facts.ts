// What the pages say of the packages, read from the packages themselves: their manifests, their READMEs and the
// compatibility table. Nothing here is written by hand, so a page cannot name a version or a count the tree does not.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS, type Kind, ROLES } from "../content.ts";

/** The repository root, four directories above this file. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** This package's directory. */
export const HERE = join(ROOT, "packages/docs-effect");

/** One library package as the pages show it. */
export interface Package {
	/** Its directory under `packages`, which is also its page's name: `thread-effect`. */
	readonly directory: string;
	readonly name: string;
	readonly kind: Kind;
	readonly description: string;
	/** Its role in one sentence (`ROLES`). */
	readonly role: string;
	/** Its entry points as import specifiers: `@effectified/pi-thread`, `@effectified/pi-thread/rivet`. */
	readonly entries: ReadonlyArray<string>;
	readonly readme: string;
	/** How many tests its suite has on Node, by the compatibility table. */
	readonly tests: number;
}

/** Everything the pages state as fact. */
export interface Facts {
	/** The library packages, by kind in the order of `KINDS`, then by directory. */
	readonly packages: ReadonlyArray<Package>;
	/** The version the pi-effect packages share. */
	readonly version: string;
	/** The exact version of Pi every package pins. */
	readonly pi: string;
	/** The range of `effect` every package takes as a peer. */
	readonly effect: string;
	/** The range of `rivetkit` the host takes as a peer. */
	readonly rivetkit: string;
	/** The lowest Node version the packages declare. */
	readonly node: string;
	/** The Node and Bun versions the whole suite last ran on. */
	readonly ranOn: { readonly node: string; readonly bun: string };
	/** The repository as a web address, and the branch the packages live on. */
	readonly repository: string;
	readonly branch: string;
}

/** A manifest as far as this file reads it. Trust boundary: a manifest is a file, read as untyped JSON. */
interface Manifest {
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly piEffect?: { readonly kind?: string };
	readonly exports?: Readonly<Record<string, unknown>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly engines?: { readonly node?: string };
	readonly repository?: { readonly url?: string };
}

/** Reads the facts from the tree. Throws, naming what is missing, when a package has no role or no row. */
export function read(): Facts {
	const compat = readFileSync(join(ROOT, "effect/COMPAT.md"), "utf8");
	const counts = testCounts(compat);
	const manifests = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.endsWith("-effect"))
		.map((entry) => ({ directory: entry.name, manifest: manifestOf(entry.name) }))
		.filter(({ manifest }) => manifest.piEffect?.kind !== "docs");
	const packages = manifests.map(({ directory, manifest }): Package => {
		const kind = KINDS.find((known) => known === manifest.piEffect?.kind);
		const role = ROLES[directory];
		const tests = counts.get(manifest.name);
		if (kind === undefined)
			throw new Error(`${directory}: its kind ${manifest.piEffect?.kind} is none the pages know`);
		if (role === undefined) throw new Error(`${directory}: no role in packages/docs-effect/src/content.ts (ROLES)`);
		if (tests === undefined) throw new Error(`${directory}: no row in the package table of effect/COMPAT.md`);
		const entries = Object.keys(manifest.exports ?? {})
			.filter((subpath) => subpath !== "./package.json")
			.map((subpath) => (subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
		const readme = readFileSync(join(ROOT, "packages", directory, "README.md"), "utf8");
		return { directory, name: manifest.name, kind, description: manifest.description, role, entries, readme, tests };
	});
	const unknown = Object.keys(ROLES).filter((directory) => !packages.some((pkg) => pkg.directory === directory));
	if (unknown.length > 0) throw new Error(`ROLES names packages that do not exist: ${unknown.join(", ")}`);
	const first = manifests[0]?.manifest;
	const host = manifests.find(({ manifest }) => manifest.piEffect?.kind === "host")?.manifest;
	const pin = manifests
		.flatMap(({ manifest }) => Object.entries(manifest.dependencies ?? {}))
		.find(([name]) => name.startsWith("@earendil-works/"));
	const effect = first?.peerDependencies?.effect;
	const rivetkit = host?.peerDependencies?.rivetkit;
	const node = first?.engines?.node;
	const url = /github\.com\/[^/]+\/[^/.]+/.exec(first?.repository?.url ?? "")?.[0];
	if (first === undefined || pin === undefined || effect === undefined || rivetkit === undefined) {
		throw new Error("the manifests name no Pi pin, no effect peer or no rivetkit peer");
	}
	if (node === undefined || url === undefined) throw new Error("the manifests name no Node version or no repository");
	return {
		packages: [...packages].sort(
			(a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.directory.localeCompare(b.directory),
		),
		version: first.version,
		pi: pin[1],
		effect,
		rivetkit,
		node: node.replace(/^>=/, ""),
		ranOn: ranOn(compat),
		repository: `https://${url}`,
		branch: "effect",
	};
}

/** Every Markdown file of a directory tree, as paths from the repository root. */
export function markdownIn(directory: string): string[] {
	const absolute = join(ROOT, directory);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true })
		.flatMap((entry) => {
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) return markdownIn(path);
			return entry.name.endsWith(".md") ? [path] : [];
		})
		.sort();
}

function manifestOf(directory: string): Manifest {
	return JSON.parse(readFileSync(join(ROOT, "packages", directory, "package.json"), "utf8"));
}

/** The test count of each package, from the table "Packages" of COMPAT.md: its first and fourth cells. */
function testCounts(compat: string): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const line of compat.split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		const name = /^`(@effectified\/pi-[a-z-]+)`$/.exec(cells[1] ?? "")?.[1];
		const count = Number((cells[4] ?? "").replaceAll(",", ""));
		if (name !== undefined && Number.isInteger(count) && cells[4] !== "") counts.set(name, count);
	}
	return counts;
}

/** The Node and Bun versions of the first row of COMPAT.md's version table. */
function ranOn(compat: string): Facts["ranOn"] {
	const lines = compat.split("\n");
	const header = lines.findIndex((line) => line.startsWith("| pi-effect |"));
	const cells = (lines[header + 2] ?? "").split("|").map((cell) => cell.trim());
	const node = /^\d+\.\d+\.\d+/.exec(cells[4] ?? "")?.[0];
	const bun = /^\d+\.\d+\.\d+/.exec(cells[5] ?? "")?.[0];
	if (header === -1 || node === undefined || bun === undefined) {
		throw new Error("effect/COMPAT.md has no version table whose first row names a Node and a Bun version");
	}
	return { node, bun };
}
