// Scaffolds a pi-effect package: its manifest, build and test configs and an empty entry point, in the shape
// every package shares. Run `npm install --ignore-scripts` afterwards to link it and refresh the lockfile.
// Usage: node effect/scripts/new-package.ts <directory> <facade|plugin|host|composition> <description> [dependency ...]
//   A dependency is `name@version` (run time) or `dev:name@version` (tests only), such as
//   `@effectified/pi-durable@0.1.0` or `dev:@earendil-works/pi-schema@1.6.0`.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./packages.ts";

const [directory, kind, description, ...dependencySpecs] = process.argv.slice(2);
if (directory === undefined || !directory.endsWith("-effect") || description === undefined) {
	console.error("Usage: node effect/scripts/new-package.ts <name>-effect <facade|plugin|host> <description> [deps]");
	process.exit(1);
}
if (kind !== "facade" && kind !== "plugin" && kind !== "host" && kind !== "composition") {
	console.error(`Unknown kind ${kind}: facade, plugin, host or composition`);
	process.exit(1);
}
const target = join(ROOT, "packages", directory);
if (existsSync(target)) {
	console.error(`packages/${directory} already exists`);
	process.exit(1);
}

const dependencies: Record<string, string> = {};
const devDependencies: Record<string, string> = { effect: "4.1.5", vitest: "4.1.12" };
for (const spec of dependencySpecs) {
	const dev = spec.startsWith("dev:");
	const pinned = dev ? spec.slice("dev:".length) : spec;
	const at = pinned.lastIndexOf("@");
	if (at <= 0) {
		console.error(`Dependency ${spec} needs an exact version: name@version`);
		process.exit(1);
	}
	(dev ? devDependencies : dependencies)[pinned.slice(0, at)] = pinned.slice(at + 1);
}

const manifest = {
	name: `@effectified/pi-${directory.slice(0, -"-effect".length)}`,
	version: "0.1.0",
	description,
	type: "module",
	main: "./dist/index.js",
	types: "./dist/index.d.ts",
	exports: {
		".": { source: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
		"./package.json": "./package.json",
	},
	sideEffects: false,
	piEffect: { kind },
	files: ["dist", "README.md"],
	scripts: {
		clean: "node ../../scripts/package-files.mjs clean dist",
		build: "tsc -p tsconfig.build.json",
		test: "vitest --run",
		prepublishOnly: "npm run clean && npm run build",
	},
	keywords: ["effect", "pi"],
	author: "Gunther Brunner",
	license: "MIT",
	repository: {
		type: "git",
		url: "git+https://github.com/effectified/pi.git",
		directory: `packages/${directory}`,
	},
	engines: { node: ">=22.19.0" },
	dependencies: sorted(dependencies),
	peerDependencies: { effect: "~4.1.5" },
	devDependencies: sorted(devDependencies),
};

const buildConfig = {
	extends: "../../tsconfig.base.json",
	compilerOptions: { outDir: "./dist", rootDir: "./src" },
	include: ["src/**/*.ts"],
	exclude: ["node_modules", "dist", "**/*.d.ts", "src/**/*.d.ts"],
};

const vitestConfig = `import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		// A file that needs Bun (bun:sqlite) runs in the Bun lane only.
		exclude: [...configDefaults.exclude, "test/**/*.bun.test.ts"],
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
`;

mkdirSync(join(target, "src"), { recursive: true });
mkdirSync(join(target, "test"), { recursive: true });
writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(join(target, "tsconfig.build.json"), `${JSON.stringify(buildConfig, null, "\t")}\n`);
writeFileSync(join(target, "vitest.config.ts"), vitestConfig);
writeFileSync(join(target, "src/index.ts"), `// ${description}.\n\nexport {};\n`);
console.log(`Created packages/${directory} (${manifest.name}, ${kind}).`);

function sorted(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
