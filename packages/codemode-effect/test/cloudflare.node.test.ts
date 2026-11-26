/// <reference path="../../codemode/src/cloudflare-modules.d.ts" />
// Pi's `/cloudflare` imports modules only Wrangler provides; the reference above declares them for the type check, as
// pi-codemode's own build does.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * `fixtures/cloudflare-worker.ts` bundled as Wrangler would bundle it: `cloudflare:workers` from the runtime, and
 * QuickJS as a compiled WebAssembly module (Wrangler's `CompiledWasm` rule), so `cloudflareQuickJSWasm` is one.
 */
async function bundle(): Promise<string> {
	const output = await build({
		entryPoints: [fileURLToPath(new URL("./fixtures/cloudflare-worker.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		target: "es2022",
		conditions: ["source", "workerd", "worker", "import"],
		mainFields: ["module", "main"],
		external: ["cloudflare:workers", "quickjs-wasi/quickjs.wasm", "node:*"],
	});
	return output.outputFiles[0]?.text ?? "";
}

// workerd runs on Node through Miniflare; Bun runs this file too, since its runner takes every test file: skipped there.
describe.skipIf("Bun" in globalThis)("the Cloudflare entry in workerd", () => {
	let miniflare: Miniflare;

	beforeAll(async () => {
		miniflare = new Miniflare({
			workers: [
				{
					config: {
						name: "main",
						compatibilityDate: "2026-04-22",
						compatibilityFlags: ["nodejs_compat"],
						manifest: {
							mainModule: "worker.js",
							modules: {
								"worker.js": { type: "esm", contents: await bundle() },
								"quickjs-wasi/quickjs.wasm": {
									type: "wasm",
									contents: new Uint8Array(readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"))),
								},
							},
						},
						exports: { CodemodeSandbox: { type: "durable-object", storage: "sqlite" } },
						env: { SANDBOX: { type: "durable-object", worker: "main", exportName: "CodemodeSandbox" } },
					},
				},
			],
		});
		await miniflare.ready;
	}, 60_000);

	afterAll(() => miniflare?.dispose());

	/** What the Worker answers on `path`. */
	async function get(path: string): Promise<unknown> {
		const response = await miniflare.dispatchFetch(`http://localhost${path}`);
		return response.json();
	}

	it("offers Pi's own values: Wrangler's QuickJS module, the memory limit and the Durable Object", async () => {
		expect(await get("/offered")).toEqual([true, true, true]);
	});

	it("runs InlineSandbox.make on cloudflareQuickJSWasm, with an Effect tool", async () => {
		expect(await get("/inline")).toMatchObject({
			ok: true,
			value: "Hello, Cloudflare",
			output: [{ type: "text", text: "in workerd" }],
			calls: [{ name: "greet", status: "ok" }],
		});
	});

	it("runs RemoteSandbox.make against the entry's Durable Object, the tool in the calling Worker", async () => {
		expect(await get("/remote")).toMatchObject({
			ok: true,
			value: "Hello, Cloudflare",
			output: [{ type: "text", text: "in workerd" }],
			calls: [{ name: "greet", status: "ok" }],
		});
	});
});
