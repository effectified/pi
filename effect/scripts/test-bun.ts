// The Bun lane: runs each pi-effect package's Vitest files under `bun test`, because Bun is the products' runtime.
// Packages that import a Pi package without a `source` export (pi-ai) need upstream's `npm run build` first.
// Usage: node effect/scripts/test-bun.ts [package directory name ...]   (all pi-effect packages when none is given)

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { effectPackages, ROOT } from "./packages.ts";

const selected = new Set(process.argv.slice(2));
const packages = effectPackages().filter(
	(pkg) => selected.size === 0 || selected.has(pkg.directory.slice("packages/".length)),
);

let failed = false;
for (const pkg of packages) {
	console.log(`bun test: ${pkg.name}`);
	// `source` resolves workspace packages to their TypeScript, as each package's vitest.config.ts does.
	const cwd = join(ROOT, pkg.directory);
	const result = spawnSync("bun", ["test", "--conditions=source"], { cwd, stdio: "inherit" });
	if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
