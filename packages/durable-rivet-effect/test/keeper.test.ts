// The watcher of a local engine, on stand-ins for the engine: processes that name a directory's configuration file
// on their command line, as an engine does. The watched process is one of its own (keeper-process.ts).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";

const script = new URL("./keeper-process.ts", import.meta.url).pathname;

const root = mkdtempSync(join(tmpdir(), "pi-rivet-test-keeper-"));
const started: Array<ChildProcess> = [];

afterAll(() => {
	for (const child of started) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

/** A process that runs until it is stopped and names the configuration file of `directory`, in a group of its own. */
const engineOn = (
	directory: string,
): { readonly pid: number; readonly ended: Promise<void>; readonly runs: () => boolean } => {
	const child = spawn(
		"/bin/sh",
		["-c", "while :; do sleep 1; done", "rivet-engine", "--config", EngineProcess.config(directory)],
		{ detached: true, stdio: "ignore" },
	);
	started.push(child);
	let running = true;
	const ended = new Promise<void>((resolve) => {
		child.once("exit", () => {
			running = false;
			resolve();
		});
	});
	return { pid: child.pid ?? 0, ended, runs: () => running };
};

/** The watched process, once it has said `word`. */
const watched = async (word: string, args: ReadonlyArray<string>): Promise<ChildProcess> => {
	const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"] });
	started.push(child);
	await new Promise<void>((resolve, reject) => {
		let said = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			said += chunk.toString();
			if (said.includes(word)) resolve();
		});
		child.once("exit", () => reject(new Error(`the watched process ended before it said "${word}": ${said}`)));
	});
	return child;
};

const within = (millis: number, ended: Promise<void>): Promise<boolean> =>
	Promise.race([ended.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), millis))]);

describe("Keeper", () => {
	it("stops the engine of its directory when its process is killed, and no engine of a directory beside it", async () => {
		const directory = join(root, "org-1");
		const engine = engineOn(directory);
		const beside = engineOn(join(root, "org-10"));
		const process = await watched("watching", [directory, "killed"]);
		process.kill("SIGKILL");
		expect(await within(15_000, engine.ended)).toBe(true);
		expect(beside.runs()).toBe(true);
	}, 30_000);

	it("stops only the processes it was told are its engine", async () => {
		const directory = join(root, "told");
		const own = engineOn(directory);
		const next = engineOn(directory);
		const process = await watched("watching", [directory, "killed", String(own.pid)]);
		process.kill("SIGKILL");
		expect(await within(15_000, own.ended)).toBe(true);
		// The engine another process started on the directory since: its watcher's to stop, not this one's.
		expect(await within(2_000, next.ended)).toBe(false);
	}, 30_000);

	it("stops nothing when its scope is closed, also when the process ends afterwards", async () => {
		const directory = join(root, "closed");
		const engine = engineOn(directory);
		const process = await watched("closed", [directory, "closed"]);
		await new Promise<void>((resolve) => {
			if (process.exitCode !== null) resolve();
			else process.once("exit", () => resolve());
		});
		expect(await within(2_000, engine.ended)).toBe(false);
	}, 30_000);
});
