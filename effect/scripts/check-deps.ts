// Fails when a pi-effect package breaks the dependency rules of PRD sections 5.4 and 8, so every package stays
// installable alone and movable to another home; and when code an application would write imports Pi itself.
// Usage: node effect/scripts/check-deps.ts

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { buildOrder, type EffectPackage, effectPackages, ROOT, runtimeDependencies } from "./packages.ts";

const packages = effectPackages();
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const failures: string[] = [];

// Type-only imports count too: a published `.d.ts` keeps them, so the package they name must be installable.
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?["']([^"']+)["']/g;

/**
 * Imports of Pi that a README or a documentation page may still show, each with why: what the facades do not offer
 * yet. Each entry is an open entry of a facade's coverage (`test/index.test.ts`).
 */
const DOCUMENTED_PI_IMPORTS: ReadonlyMap<string, string> = new Map<string, string>([]);

for (const pkg of packages) {
	const testDependencies = [...runtimeDependencies(pkg), ...Object.keys(pkg.devDependencies)];
	// A docs package ships built pages and no code: what its generator imports is a development dependency.
	const sourceDependencies = pkg.kind === "docs" ? testDependencies : runtimeDependencies(pkg);
	for (const file of sourceFiles(join(ROOT, pkg.directory, "src"))) checkImports(pkg, file, sourceDependencies);
	for (const file of sourceFiles(join(ROOT, pkg.directory, "test"))) checkImports(pkg, file, testDependencies);
	checkKinds(pkg);
	checkWrittenOnFacades(pkg);
}
checkDocumentation();
checkSingleVersion("effect peer range", (pkg) => (pkg.kind === "docs" ? [] : [pkg.peerDependencies.effect]));
checkSingleVersion("upstream Pi version", (pkg) =>
	Object.entries(pkg.dependencies)
		.filter(([name]) => name.startsWith("@earendil-works/"))
		.map(([, version]) => version),
);
const order = buildOrder(packages);
if (order.kind === "cycle") failures.push(`dependency cycle among: ${order.names.join(", ")}`);

if (failures.length > 0) {
	console.error("pi-effect dependency rules broken:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`Dependency rules hold for ${packages.length} pi-effect packages.`);

/** Every `.ts` file below `directory`; none when it does not exist. */
function sourceFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** Each import of `file` is relative, declared in `declared`, or a platform built-in in a file named for it. */
function checkImports(pkg: EffectPackage, file: string, declared: readonly string[]): void {
	const where = relative(ROOT, file);
	const inSource = where.startsWith(`${pkg.directory}/src/`);
	for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
		const specifier = match[1];
		if (specifier.startsWith(".")) continue;
		if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
			// The core of a package runs on Bun, Node, Workers and browsers; platform code sits behind a subpath.
			if (inSource && !/(?:^|\/)(?:node|bun)(?:\/|\.ts$)/.test(where.slice(pkg.directory.length + "/src/".length))) {
				failures.push(`${where}: imports ${specifier} outside a node or bun file or directory`);
			}
			continue;
		}
		const name = specifier
			.split("/")
			.slice(0, specifier.startsWith("@") ? 2 : 1)
			.join("/");
		if (name === pkg.name || declared.includes(name)) continue;
		failures.push(`${where}: imports ${specifier}, which ${pkg.name} does not declare`);
	}
}

/**
 * A facade depends on facades only. A plugin never depends on another plugin; it may depend on a host only when
 * its own name says so (`rivet`), or from a subpath that does, which it declares as an optional peer. The
 * composition may depend on all of them, as a product does, and nothing depends on it, tests included.
 */
function checkKinds(pkg: EffectPackage): void {
	for (const name of [...runtimeDependencies(pkg), ...Object.keys(pkg.devDependencies)]) {
		if (byName.get(name)?.kind !== "composition") continue;
		failures.push(`${pkg.name}: depends on the composition ${name}`);
	}
	for (const name of [...runtimeDependencies(pkg), ...Object.keys(pkg.devDependencies)]) {
		if (byName.get(name)?.kind === "docs") failures.push(`${pkg.name}: depends on the docs package ${name}`);
	}
	if (pkg.kind === "docs" && manifestOf(pkg).private !== true) failures.push(`${pkg.name}: a docs package is private`);
	if (pkg.kind === "composition" || pkg.kind === "docs") return;
	for (const name of runtimeDependencies(pkg)) {
		const dependency = byName.get(name);
		if (dependency === undefined || dependency.kind === "facade") continue;
		if (pkg.kind === "facade") failures.push(`${pkg.name}: a facade depends on the ${dependency.kind} ${name}`);
		else if (dependency.kind === "plugin") failures.push(`${pkg.name}: depends on the plugin ${name}`);
		else if (pkg.kind === "plugin" && !(name in pkg.peerDependencies)) {
			failures.push(`${pkg.name}: the host ${name} must be an optional peer, used from a subpath named for it`);
		}
	}
}

/**
 * Plugins and the composition are written as an application is, on the facades alone: an import of Pi in them is
 * something the facades do not offer yet, so it belongs in the facade (offered, or wrapped), not here.
 */
function checkWrittenOnFacades(pkg: EffectPackage): void {
	if (pkg.kind !== "plugin" && pkg.kind !== "composition") return;
	for (const file of sourceFiles(join(ROOT, pkg.directory, "src"))) {
		for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
			if (match[1].startsWith("@earendil-works/"))
				failures.push(`${relative(ROOT, file)}: imports ${match[1]}; import it from a facade`);
		}
	}
}

/** The code in every README and documentation page imports effectified packages only, but for the listed imports. */
function checkDocumentation(): void {
	const pages = [
		...packages.map((pkg) => join(ROOT, pkg.directory, "README.md")),
		...markdownFiles(join(ROOT, "packages/docs-effect/docs")),
	].filter((page) => existsSync(page));
	const used = new Set<string>();
	for (const page of pages) {
		for (const match of readFileSync(page, "utf8").matchAll(IMPORT)) {
			if (!match[1].startsWith("@earendil-works/")) continue;
			const key = `${relative(ROOT, page)} ${match[1]}`;
			used.add(key);
			if (!DOCUMENTED_PI_IMPORTS.has(key))
				failures.push(`${relative(ROOT, page)}: shows an import of ${match[1]}; show the facade's`);
		}
	}
	for (const key of DOCUMENTED_PI_IMPORTS.keys()) {
		if (!used.has(key)) failures.push(`DOCUMENTED_PI_IMPORTS lists ${key}, which no page shows any more`);
	}
}

/** Every `.md` file below `directory`; none when it does not exist. */
function markdownFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return markdownFiles(path);
		return entry.name.endsWith(".md") ? [path] : [];
	});
}

/** A package's manifest as it is written. */
function manifestOf(pkg: EffectPackage): { readonly private?: unknown } {
	// Trust boundary: a manifest is a file, read as untyped JSON.
	return JSON.parse(readFileSync(join(ROOT, pkg.directory, "package.json"), "utf8"));
}

/** Every package declares the same value, so a consumer installs one copy of `effect` and one Pi version. */
function checkSingleVersion(what: string, versions: (pkg: EffectPackage) => (string | undefined)[]): void {
	const seen = new Map<string, string[]>();
	for (const pkg of packages) {
		for (const version of versions(pkg)) {
			if (version === undefined) failures.push(`${pkg.name}: declares no ${what}`);
			else seen.set(version, [...(seen.get(version) ?? []), pkg.name]);
		}
	}
	if (seen.size > 1) {
		const found = [...seen].map(([version, names]) => `${version} (${names.join(", ")})`).join("; ");
		failures.push(`more than one ${what}: ${found}`);
	}
}
