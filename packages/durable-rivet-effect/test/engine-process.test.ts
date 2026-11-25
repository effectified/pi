// The engine processes of a directory, on stand-ins for the engine: processes that name a directory's configuration
// file on their command line, as an engine does.

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { runLive } from "@gunta/pi-ai-effect/testing";
import { Effect, Layer, PlatformError } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { afterAll, describe, expect, it } from "vitest";
import * as EngineProcess from "../src/node/engine-process.ts";
import * as Platform from "../src/node/platform.ts";

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

/** A spawner on a machine without `ps`: every command fails to start, as Node's spawner reports it. */
const withoutPs = Layer.succeed(
	ChildProcessSpawner.ChildProcessSpawner,
	ChildProcessSpawner.make(() =>
		Effect.fail(
			PlatformError.systemError({
				_tag: "NotFound",
				module: "ChildProcess",
				method: "spawn",
				description: "spawn ps ENOENT",
			}),
		),
	),
);

describe("EngineProcess", () => {
	it("names the configuration file rivetkit keeps in an engine's directory, whatever way the directory is written", () => {
		expect(EngineProcess.config("/data/engines/org-1")).toBe("/data/engines/org-1/.rivetkit/var/engine/config.json");
		expect(EngineProcess.config("/data/engines/x/../org-1/")).toBe(EngineProcess.config("/data/engines/org-1"));
		expect(EngineProcess.config("engines")).toBe(join(process.cwd(), "engines/.rivetkit/var/engine/config.json"));
	});

	it("finds the engines of a directory, and none of a directory whose name begins with it", () =>
		runLive(
			Effect.gen(function* () {
				const one = engineOn("/nowhere/pi-rivet-test/org-1");
				const ten = engineOn("/nowhere/pi-rivet-test/org-10");
				expect(yield* Platform.running("/nowhere/pi-rivet-test/org-1")).toEqual([one]);
				expect(yield* Platform.running("/nowhere/pi-rivet-test/org-10")).toEqual([ten]);
				expect(yield* Platform.running("/nowhere/pi-rivet-test/org")).toEqual([]);
			}),
		));

	it(
		"stops the engines of a directory and leaves the ones of another",
		() =>
			runLive(
				Effect.gen(function* () {
					const stopped = engineOn("/nowhere/pi-rivet-test/stopped");
					const left = engineOn("/nowhere/pi-rivet-test/left");
					yield* Platform.stop("/nowhere/pi-rivet-test/stopped");
					expect(yield* Platform.running("/nowhere/pi-rivet-test/stopped")).toEqual([]);
					expect(yield* Platform.running("/nowhere/pi-rivet-test/left")).toEqual([left]);
					expect(stopped).not.toBe(left);
				}),
			),
		20_000,
	);

	it("fails with a typed error that names the reason when the process list cannot be read, and finds no engine", () =>
		runLive(
			Effect.gen(function* () {
				const listed = yield* Effect.flip(
					Effect.provide(EngineProcess.running("/nowhere/pi-rivet-test/x"), withoutPs),
				);
				const stopped = yield* Effect.flip(
					Effect.provide(EngineProcess.stop("/nowhere/pi-rivet-test/x"), withoutPs),
				);
				for (const failed of [listed, stopped]) {
					expect(failed).toMatchObject({ _tag: "EngineUnavailable", code: "environment", retryable: false });
					expect(failed.message).toContain("could not be read with ps");
					expect(failed.message).toContain("NotFound: ChildProcess.spawn");
				}
			}),
		));
});
