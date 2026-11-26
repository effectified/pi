import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.ts";

const AGENT = fileURLToPath(new URL("./fixtures/agent.ts", import.meta.url));

/** Whether a `node` that runs TypeScript is on the PATH: the fixture agent runs in it. */
const node = spawnSync("node", ["--version"], { encoding: "utf8" });
const NO_NODE = node.status !== 0 || Number(node.stdout.slice(1).split(".")[0]) < 23;

/** Runs the fixture agent with `args` and gives its output and exit code. */
function agent(...args: string[]) {
	const run = spawnSync("node", ["--conditions=source", AGENT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
		timeout: 60_000,
	});
	return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}

describe.skipIf(NO_NODE)("Modes (in a process of their own: they own stdout, and Pi's CLI ends its process)", () => {
	it("print runs one prompt and writes the answer to stdout", () => {
		const run = agent("print", "Hello.");
		expect(run.stdout.trim()).toBe("Answer 1.");
		expect(run.status).toBe(0);
	});

	it("main runs Pi's CLI with the given arguments", () => {
		const run = agent("main", "--version");
		expect(run.stdout.trim()).toBe(VERSION);
		expect(run.status).toBe(0);
	});
});
