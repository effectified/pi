// Packs every public pi-effect package into one directory as tarballs: what `npm publish <tarball>` publishes, in
// dependency order, and what a product installs before a release (`effect/PATENTOS.md`). Each package is built
// first, in dependency order, so a tarball never holds an older `dist` than its source. A tarball's manifest has no
// `source` condition: it points at `src`, which a tarball does not hold. Upstream's `npm run build` must have run once (the packages resolve Pi's `dist`).
// It refuses to run when the packages' Pi pins are not what the tree has (`pins.ts`): the product installs those
// pins. `--unreleased-pi` builds against Pi sources their version did not release, on purpose. `SOURCE.json` in the
// directory names the commit and the Pi the packages were built against.
// Usage: node effect/scripts/pack.ts <directory> [--unreleased-pi]

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutSource } from "./manifest.ts";
import { buildOrder, effectPackages, ROOT } from "./packages.ts";
import { productPins, sourceRecord } from "./pins.ts";

const args = process.argv.slice(2);
const [destination] = args.filter((arg) => !arg.startsWith("--"));
if (destination === undefined) {
	console.error("Usage: node effect/scripts/pack.ts <directory> [--unreleased-pi]");
	process.exit(1);
}
const { version, release } = productPins("pack.ts", args);
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
	run(pkg.name, "npm", ["run", "build"], directory);
	// Packed once as the repository has it, then again with the manifest a consumer gets: the package's own
	// manifest is never rewritten, since other agents work in this tree.
	const staging = mkdtempSync(join(tmpdir(), "pi-effect-pack-"));
	run(pkg.name, "npm", ["pack", "--ignore-scripts", "--pack-destination", staging], directory);
	const [tarball] = readdirSync(staging);
	run(pkg.name, "tar", ["-xzf", tarball ?? "", "-C", staging], staging);
	const manifestPath = join(staging, "package", "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ ...manifest, exports: withoutSource(manifest.exports) }, null, "\t")}\n`,
	);
	run(pkg.name, "npm", ["pack", "--ignore-scripts", "--pack-destination", target], join(staging, "package"));
	rmSync(staging, { recursive: true });
	console.log(`Packed ${pkg.name}@${pkg.version}`);
}
writeFileSync(join(target, "SOURCE.json"), `${JSON.stringify(sourceRecord(version, release), null, 2)}\n`);

/** Runs `command` in `cwd` and ends the script when it fails. */
function run(name: string, command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
	if (result.status === 0) return;
	console.error(`${name}: ${command} ${args[0]} failed`);
	process.exit(result.status ?? 1);
}
