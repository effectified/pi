// Packs every public pi-effect package into one directory as tarballs, for a product that installs them before they
// are published (`effect/PATENTOS.md`). Each package is built first, in dependency order, so a tarball never holds
// an older `dist` than its source. Upstream's `npm run build` must have run once (the packages resolve Pi's `dist`).
// Usage: node effect/scripts/pack.ts <directory>

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildOrder, effectPackages, ROOT } from "./packages.ts";

const [destination] = process.argv.slice(2);
if (destination === undefined) {
	console.error("Usage: node effect/scripts/pack.ts <directory>");
	process.exit(1);
}
const target = resolve(destination);
mkdirSync(target, { recursive: true });

const order = buildOrder(effectPackages());
if (order.kind === "cycle") {
	console.error(`Cannot order the build, dependency cycle among: ${order.names.join(", ")}`);
	process.exit(1);
}

for (const pkg of order.packages) {
	const directory = join(ROOT, pkg.directory);
	// Trust boundary: a manifest is a file, read as untyped JSON.
	if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).private === true) continue;
	for (const args of [
		["run", "build"],
		["pack", "--ignore-scripts", "--pack-destination", target],
	]) {
		const result = spawnSync("npm", args, { cwd: directory, stdio: ["ignore", "ignore", "inherit"] });
		if (result.status !== 0) {
			console.error(`${pkg.name}: npm ${args[0]} failed`);
			process.exit(result.status ?? 1);
		}
	}
	console.log(`Packed ${pkg.name}@${pkg.version}`);
}
