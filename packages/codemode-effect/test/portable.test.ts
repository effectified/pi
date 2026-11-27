import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Wasm } from "../src/index.ts";
import { type CodemodeRemote, InlineSandbox, RemoteSandbox } from "../src/portable.ts";
import { greet } from "./tools.ts";

describe("the portable entry", () => {
	it("runs scripts on the calling thread and on a remote, with what it exports alone", async () => {
		const [inline, remote] = await runTest(
			Effect.gen(function* () {
				// Off Cloudflare, the module comes from the root entry; on Cloudflare, from `/cloudflare`.
				const wasm = yield* Wasm.load();
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				const served: CodemodeRemote = {
					execute: (request, exchange) => runPromise(RemoteSandbox.serve(request, exchange, { wasm })),
				};
				const script = `return await tools.greet({ name: "portable" });`;
				const onThread = yield* InlineSandbox.make({ wasm, tools: [greet] });
				const onRemote = yield* RemoteSandbox.make({ tools: [greet], remote: Effect.succeed(served) });
				return [yield* onThread.execute(script), yield* onRemote.execute(script)] as const;
			}),
		);
		expect(inline).toMatchObject({ ok: true, value: "Hello, portable" });
		expect(remote).toMatchObject({ ok: true, value: "Hello, portable" });
	});
});
