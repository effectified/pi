// The engine processes of a directory, on stand-ins for the engine: processes that name a directory's configuration
// file on their command line, as an engine does.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";

const started: Array<ChildProcess> = [];

afterAll(() => {
	for (const child of started) child.kill("SIGKILL");
});

/** The process id of a process that runs until it is stopped and names the configuration file of `directory`. */
const engineOn = (directory: string): number => {
	const child = spawn(
		"/bin/sh",
		["-c", "while :; do sleep 1; done", "rivet-engine", "--config", EngineProcess.config(directory)],
		{ detached: true, stdio: "ignore" },
	);
	started.push(child);
	return child.pid ?? 0;
};

describe("EngineProcess", () => {
	it("names the configuration file rivetkit keeps in an engine's directory, whatever way the directory is written", () => {
		expect(EngineProcess.config("/data/engines/org-1")).toBe("/data/engines/org-1/.rivetkit/var/engine/config.json");
		expect(EngineProcess.config("/data/engines/x/../org-1/")).toBe(EngineProcess.config("/data/engines/org-1"));
		expect(EngineProcess.config("engines")).toBe(join(process.cwd(), "engines/.rivetkit/var/engine/config.json"));
	});

	it("finds the engines of a directory, and none of a directory whose name begins with it", async () => {
		const one = engineOn("/nowhere/pi-rivet-test/org-1");
		const ten = engineOn("/nowhere/pi-rivet-test/org-10");
		expect(await Effect.runPromise(EngineProcess.running("/nowhere/pi-rivet-test/org-1"))).toEqual([one]);
		expect(await Effect.runPromise(EngineProcess.running("/nowhere/pi-rivet-test/org-10"))).toEqual([ten]);
		expect(await Effect.runPromise(EngineProcess.running("/nowhere/pi-rivet-test/org"))).toEqual([]);
	});

	it("stops the engines of a directory and leaves the ones of another", async () => {
		const stopped = engineOn("/nowhere/pi-rivet-test/stopped");
		const left = engineOn("/nowhere/pi-rivet-test/left");
		await Effect.runPromise(EngineProcess.stop("/nowhere/pi-rivet-test/stopped"));
		expect(await Effect.runPromise(EngineProcess.running("/nowhere/pi-rivet-test/stopped"))).toEqual([]);
		expect(await Effect.runPromise(EngineProcess.running("/nowhere/pi-rivet-test/left"))).toEqual([left]);
		expect(stopped).not.toBe(left);
	}, 20_000);
});
