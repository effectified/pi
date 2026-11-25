// Builds every pi-effect package in dependency order (each with its own `npm run build`), after upstream's
// `npm run build`, whose `dist` output their type declarations resolve against.
// Usage: node effect/scripts/build.ts

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildOrder, effectPackages, ROOT } from "./packages.ts";

const order = buildOrder(effectPackages());
if (order.kind === "cycle") {
	console.error(`Cannot order the build, dependency cycle among: ${order.names.join(", ")}`);
	process.exit(1);
}

for (const pkg of order.packages) {
	console.log(`Building ${pkg.name}`);
	const result = spawnSync("npm", ["run", "build"], { cwd: join(ROOT, pkg.directory), stdio: "inherit" });
	if (result.status !== 0) process.exit(result.status ?? 1);
}
