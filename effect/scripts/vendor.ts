// Writes every public pi-effect package into one directory in workspace form, for a product that keeps them in its
// own repository as workspace packages and never installs a published one (`effect/PATENTOS.md`). Each package is
// built first, in dependency order. A package's directory holds its `dist` without source maps (the sources are not
// copied), its README and a manifest whose pi-effect dependencies are `workspace:*` and whose peers are exact.
// It refuses to run when the packages' Pi pins are not what the tree has (`pins.ts`): the product installs those
// pins. `--unreleased-pi` builds against Pi sources their version did not release, on purpose. `SOURCE.json` in the
// directory names the commit and the Pi the packages were built against.
// Usage: node effect/scripts/vendor.ts <directory> [--unreleased-pi]

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { withoutSource } from "./manifest.ts";
import { buildOrder, effectPackages, ROOT } from "./packages.ts";
import { productPins, sourceRecord } from "./pins.ts";

const SCOPE = "@effectified/pi-";
// The packages' names before 2026-11-26. A product vendored then still holds them, and they must go before the
// renamed ones land in the same directories. Remove it once PatentOS has vendored the renamed packages.
const FORMER_SCOPE = "@gunta/pi-";
const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\s*$/;

const args = process.argv.slice(2);
const [destination] = args.filter((arg) => !arg.startsWith("--"));
if (destination === undefined) {
	console.error("Usage: node effect/scripts/vendor.ts <directory> [--unreleased-pi]");
	process.exit(1);
}
const { version, release } = productPins("vendor.ts", args);
const target = resolve(destination);
mkdirSync(target, { recursive: true });

const order = buildOrder(effectPackages());
if (order.kind === "cycle") {
	console.error(`Cannot order the build, dependency cycle among: ${order.names.join(", ")}`);
	process.exit(1);
}

removeVendored(target);
for (const pkg of order.packages) {
	const directory = join(ROOT, pkg.directory);
	// Trust boundary: a manifest is a file, read as untyped JSON.
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	// A private package is not a product's to install. The docs package is the exception: it is private because it
	// is never published, and a product keeps its pages and its skills beside the packages they explain.
	if (manifest.private === true && pkg.kind !== "docs") continue;
	const result = spawnSync("npm", ["run", "build"], { cwd: directory, stdio: ["ignore", "ignore", "inherit"] });
	if (result.status !== 0) {
		console.error(`${pkg.name}: npm run build failed`);
		process.exit(result.status ?? 1);
	}
	const out = join(target, basename(pkg.directory));
	mkdirSync(out);
	cpSync(join(directory, "dist"), join(out, "dist"), {
		recursive: true,
		filter: (source) => !source.endsWith(".map"),
	});
	dropSourceMapComments(join(out, "dist"));
	cpSync(join(directory, "README.md"), join(out, "README.md"));
	// The pages and the skills are read where they lie: their links to one another and to the READMEs are relative,
	// and hold in a product as here. `bin` holds the script that links the skills into a project.
	if (pkg.kind === "docs") {
		for (const kept of ["docs", "skills", "bin"]) cpSync(join(directory, kept), join(out, kept), { recursive: true });
	}
	writeFileSync(join(out, "package.json"), `${JSON.stringify(workspaceManifest(manifest), null, "\t")}\n`);
	console.log(`Vendored ${pkg.name}@${pkg.version}`);
}
writeFileSync(join(target, "SOURCE.json"), `${JSON.stringify(sourceRecord(version, release), null, 2)}\n`);

/** Removes the packages an earlier run wrote into `directory`, so a package deleted here does not stay there. */
function removeVendored(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const manifestPath = join(directory, entry.name, "package.json");
		if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
		// Trust boundary: a manifest is a file, read as untyped JSON.
		const name: unknown = JSON.parse(readFileSync(manifestPath, "utf8")).name;
		const ours = typeof name === "string" && (name.startsWith(SCOPE) || name.startsWith(FORMER_SCOPE));
		if (ours) rmSync(join(directory, entry.name), { recursive: true });
	}
}

/** Removes the source map comment that ends each built file: the maps are not copied. */
function dropSourceMapComments(directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) dropSourceMapComments(path);
		else writeFileSync(path, readFileSync(path, "utf8").replace(SOURCE_MAP_COMMENT, "\n"));
	}
}

/**
 * A package's manifest as a workspace package of another repository: no scripts, no development dependencies, no
 * `source` export condition (the sources are not copied), and never published from there.
 */
function workspaceManifest(manifest: Record<string, unknown>): Record<string, unknown> {
	const { scripts: _scripts, devDependencies: _dev, files: _files, repository: _repository, ...kept } = manifest;
	return {
		...kept,
		private: true,
		exports: withoutSource(manifest.exports),
		dependencies: workspaceSpecs(manifest.dependencies),
		peerDependencies: workspaceSpecs(manifest.peerDependencies),
	};
}

/**
 * Dependency specs for a workspace: a pi-effect package is `workspace:*`, and a `~` range becomes the exact version
 * it starts at, which is the one the package is tested with.
 */
function workspaceSpecs(specs: unknown): Record<string, string> {
	if (typeof specs !== "object" || specs === null) return {};
	return Object.fromEntries(
		Object.entries(specs).map(([name, spec]) => [
			name,
			name.startsWith(SCOPE) ? "workspace:*" : String(spec).replace(/^~/, ""),
		]),
	);
}
