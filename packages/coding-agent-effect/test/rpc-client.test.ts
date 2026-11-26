import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/index.ts";

const AGENT = fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url));

/** Whether a `node` that runs TypeScript is on the PATH: Pi's RPC client starts the agent with `node`. */
const node = spawnSync("node", ["--version"], { encoding: "utf8" });
const NO_NODE = node.status !== 0 || Number(node.stdout.slice(1).split(".")[0]) < 23;

/** The fixture agent in RPC mode (`Modes.rpc`), as Pi's client starts it. */
const client = RpcClient.make({
	cliPath: AGENT,
	env: { NODE_OPTIONS: "--conditions=source", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
});

describe.skipIf(NO_NODE)("RpcClient.make (against an agent served by Modes.rpc)", () => {
	it("sends a prompt and gives its events until the agent settles", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const rpc = yield* client;
				const events = yield* rpc.promptAndWait("Hello.");
				return {
					types: events.map((event) => event.type),
					answer: yield* rpc.getLastAssistantText(),
					streaming: (yield* rpc.getState()).isStreaming,
				};
			}),
		);
		expect(seen.types).toContain("agent_start");
		expect(seen.types.at(-1)).toBe("agent_settled");
		expect(seen.answer).toBe("Answer 1.");
		expect(seen.streaming).toBe(false);
	});

	it("fails a command the agent refuses with its error as a CodingAgentError", async () => {
		const failure = await runLive(
			Effect.gen(function* () {
				const rpc = yield* client;
				return yield* Effect.flip(rpc.setModel("nowhere", "no-model"));
			}),
		);
		expect(failure._tag).toBe("CodingAgentError");
	});
});
