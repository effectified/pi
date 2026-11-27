import { existsSync } from "node:fs";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { getPowerShellConfig, getShellConfig } from "../src/index.ts";

describe("getShellConfig", () => {
	it("finds the shell bash runs commands in, a program that exists", async () => {
		const config = await runLive(getShellConfig());
		expect(existsSync(config.shell)).toBe(true);
	});

	it("takes the shell it is given", async () => {
		const config = await runLive(getShellConfig("/bin/sh"));
		expect(config.shell).toBe("/bin/sh");
	});
});

describe("getPowerShellConfig", () => {
	it.skipIf(process.platform !== "win32")("finds PowerShell on Windows", async () => {
		const config = await runLive(getPowerShellConfig);
		expect(config.shell).toMatch(/pwsh|powershell/i);
	});

	it.skipIf(process.platform === "win32")("fails off Windows with Pi's error, as a CodingAgentError", async () => {
		const failure = await runLive(Effect.flip(getPowerShellConfig));
		expect(failure).toMatchObject({
			_tag: "CodingAgentError",
			message: "The powershell tool is only available on Windows.",
		});
	});
});
