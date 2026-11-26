// The Bun lane's preload (bunfig.toml): vitest-evals 0.15.0 publishes a `source` export condition whose files it does
// not ship, and the lane runs with `--conditions=source`. Its importers load with the specifiers pointed at its `dist`.

import { plugin } from "bun";

const modules = new URL("../../../node_modules/", import.meta.url);

/** Each vitest-evals specifier pi-evals and this package import, and the file its `import` condition names. */
const DIST = new Map([
	["vitest-evals/harness", "vitest-evals/dist/harness.mjs"],
	["@vitest-evals/core/node", "@vitest-evals/core/dist/node.mjs"],
	["@vitest-evals/core", "@vitest-evals/core/dist/index.mjs"],
]);

const SPECIFIER = /(["'])(vitest-evals\/harness|@vitest-evals\/core(?:\/node)?)\1/g;

plugin({
	name: "vitest-evals from dist",
	setup(build) {
		build.onLoad({ filter: /(?:packages\/evals(?:-effect)?\/src\/[\w-]+\.ts|vitest-evals\/dist\/\w+\.mjs)$/ }, async (args) => {
			const text = await Bun.file(args.path).text();
			const contents = text.replace(
				SPECIFIER,
				(_, quote, specifier) => `${quote}${new URL(DIST.get(specifier), modules).pathname}${quote}`,
			);
			return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
		});
	},
});
