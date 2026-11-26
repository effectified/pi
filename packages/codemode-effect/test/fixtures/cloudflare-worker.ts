// A Worker that runs the Cloudflare entry in workerd: the inline sandbox on Wrangler's QuickJS module, and the remote
// sandbox against the entry's Durable Object, both with an Effect tool. Bundled and served by
// `test/cloudflare.node.test.ts`.

import * as PiCloudflare from "@earendil-works/pi-codemode/cloudflare";
import { Tool } from "@effectified/pi-agent";
import { Effect, Schema } from "effect";
import * as Cloudflare from "../../src/cloudflare.ts";

export { CodemodeSandboxDurableObject as CodemodeSandbox } from "../../src/cloudflare.ts";

interface Env {
	readonly SANDBOX: { getByName(name: string): Cloudflare.CodemodeRemote };
}

const greet = Tool.make("greet", {
	label: "Greet",
	description: "Greet someone.",
	parameters: Schema.Struct({ name: Schema.String }),
	success: Schema.String,
	handler: ({ name }) => Effect.succeed(`Hello, ${name}`),
});

const script = `text("in workerd"); return await tools.greet({ name: "Cloudflare" });`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/offered") {
			return Response.json([
				Cloudflare.cloudflareQuickJSWasm === PiCloudflare.cloudflareQuickJSWasm,
				Cloudflare.DEFAULT_REMOTE_MEMORY_LIMIT_BYTES === PiCloudflare.DEFAULT_REMOTE_MEMORY_LIMIT_BYTES,
				Cloudflare.CodemodeSandboxDurableObject === PiCloudflare.CodemodeSandboxDurableObject,
			]);
		}
		const sandbox =
			path === "/inline"
				? Cloudflare.InlineSandbox.make({ wasm: Cloudflare.cloudflareQuickJSWasm, tools: [greet] })
				: Cloudflare.RemoteSandbox.make({
						tools: [greet],
						remote: Effect.sync(() => env.SANDBOX.getByName("session")),
					});
		const result = await Effect.runPromise(Effect.scoped(Effect.flatMap(sandbox, (box) => box.execute(script))));
		return Response.json(result);
	},
};
