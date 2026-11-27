import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromResult } from "../../src/env/index.ts";
import * as NodeEnv from "../../src/env/node.ts";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "durable-effect-env-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("make", () => {
	it("is Pi's local environment at the directory: its files and commands", async () => {
		await writeFile(join(directory, "note.txt"), "hello");
		const seen = await runLive(
			Effect.gen(function* () {
				const env = yield* NodeEnv.make({ cwd: directory });
				const text = yield* Effect.flatMap(
					Effect.promise(() => env.readTextFile("note.txt", BACKGROUND_CONTEXT)),
					fromResult,
				);
				const stdout: string[] = [];
				const run = yield* Effect.flatMap(
					Effect.promise(() =>
						env.exec("echo $((6 * 7))", { onOutput: (chunk) => void stdout.push(chunk) }, BACKGROUND_CONTEXT),
					),
					fromResult,
				);
				return {
					kind: env instanceof NodeExecutionEnv,
					cwd: env.cwd,
					text,
					exit: run.exitCode,
					stdout: stdout.join("").trim(),
				};
			}),
		);
		expect(seen).toEqual({ kind: true, cwd: directory, text: "hello", exit: 0, stdout: "42" });
	});

	it("kills the commands it still runs when the scope closes", async () => {
		const exit = await runLive(
			Effect.gen(function* () {
				const left = yield* Effect.scoped(
					Effect.gen(function* () {
						const env = yield* NodeEnv.make({ cwd: directory });
						const started = Promise.withResolvers<void>();
						// Started and left running: the scope's close cleans it up.
						const running = env.exec(
							"echo started; sleep 30",
							{ onOutput: () => started.resolve() },
							BACKGROUND_CONTEXT,
						);
						yield* Effect.promise(() => started.promise);
						return { running };
					}),
				);
				return yield* Effect.promise(() => left.running);
			}),
		);
		expect(exit.ok ? exit.value.exitCode : exit.error.code).not.toBe(0);
	});
});
