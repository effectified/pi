import { runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WorkerSandbox } from "../src/index.ts";
import { greet } from "./tools.ts";

describe("the worker entry", () => {
	it("is a worker WorkerSandbox.make starts, as a bundled host passes its own file as workerUrl", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const sandbox = yield* WorkerSandbox.make({
					tools: [greet],
					workerUrl: new URL("../src/worker.ts", import.meta.url),
				});
				return yield* sandbox.execute(`return await tools.greet({ name: "worker" });`);
			}),
		);
		expect(result).toMatchObject({ ok: true, value: "Hello, worker" });
	});
});
