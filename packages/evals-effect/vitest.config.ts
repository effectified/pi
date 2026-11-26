import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * vitest-evals 0.15.0 publishes a `source` export condition whose files it does not ship, and the tests resolve with
 * `source`: each specifier pi-evals and this package import goes to the file its `import` condition names. The Bun
 * lane does the same in `test/bun-preload.mjs`.
 */
const dist = (file: string) => fileURLToPath(new URL(`../../node_modules/${file}`, import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		// A file that needs Bun (bun:sqlite) runs in the Bun lane only.
		exclude: [...configDefaults.exclude, "test/**/*.bun.test.ts"],
		// Loaded through Vite, so the aliases below reach vitest-evals' own import of its core.
		server: { deps: { inline: ["vitest-evals"] } },
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^vitest-evals\/harness$/, replacement: dist("vitest-evals/dist/harness.mjs") },
			{ find: /^@vitest-evals\/core\/node$/, replacement: dist("@vitest-evals/core/dist/node.mjs") },
			{ find: /^@vitest-evals\/core$/, replacement: dist("@vitest-evals/core/dist/index.mjs") },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
