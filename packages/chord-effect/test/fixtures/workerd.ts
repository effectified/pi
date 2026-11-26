// Test helper: `fixtures/cloudflare-worker.ts` in workerd through Miniflare, bundled as Wrangler would bundle it, with a
// SQLite-backed Durable Object `Store`.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/** The Worker served by a Miniflare that the caller disposes. */
export async function serve(): Promise<Miniflare> {
	const output = await build({
		entryPoints: [fileURLToPath(new URL("./cloudflare-worker.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		target: "es2022",
		conditions: ["source", "workerd", "worker", "import"],
		mainFields: ["module", "main"],
		external: ["cloudflare:workers", "node:*"],
	});
	const miniflare = new Miniflare({
		workers: [
			{
				config: {
					name: "main",
					compatibilityDate: "2026-04-22",
					compatibilityFlags: ["nodejs_compat"],
					manifest: {
						mainModule: "worker.js",
						modules: { "worker.js": { type: "esm", contents: output.outputFiles[0]?.text ?? "" } },
					},
					exports: { Store: { type: "durable-object", storage: "sqlite" } },
					env: { STORE: { type: "durable-object", worker: "main", exportName: "Store" } },
				},
			},
		],
	});
	await miniflare.ready;
	return miniflare;
}
