import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		// Bun's SQLite driver imports bun:sqlite, which Node cannot load: that file runs in the Bun lane only.
		exclude: [...configDefaults.exclude, "test/**/*.bun.test.ts"],
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
