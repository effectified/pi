import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Context, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Env from "../src/env.ts";
import * as Connection from "../src/node/connection.ts";
import * as Remote from "../src/node/remote.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

describe.skipIf(daemon === undefined || process.platform === "win32")(
	`Remote, over a daemon on this machine (${daemon ?? NO_DAEMON})`,
	() => {
		it("runs commands and file operations in the daemon", async () => {
			const seen = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const connection = yield* Connection.make({ command: [daemon!] });
					const env = yield* Remote.make({ connection, id: "pi-env:test", cwd: directory });
					yield* env.writeFile("dir/a.txt", "one\ntwo\n");
					const lines = yield* Stream.runCollect(env.textLines("dir/a.txt"));
					const output = yield* Stream.runCollect(env.execOutput("cat dir/a.txt; exit 1"));
					const listing = yield* env.listFiles(".");
					return {
						id: env.id,
						written: readFileSync(join(directory, "dir/a.txt"), "utf8"),
						lines,
						output,
						listing,
					};
				}),
			);
			expect(seen).toEqual({
				id: "pi-env:test",
				written: "one\ntwo\n",
				lines: [
					{ text: "one", terminated: true },
					{ text: "two", terminated: true },
				],
				output: [
					{ kind: "output", text: "one\ntwo\n", stream: "stdout" },
					{ kind: "exited", exitCode: 1 },
				],
				listing: {
					entries: [
						{ path: "dir", kind: "directory" },
						{ path: "dir/a.txt", kind: "file" },
					],
					truncated: false,
				},
			});
		});

		it("kills a running command when its fiber is interrupted, through the daemon", async () => {
			const exit = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const connection = yield* Connection.make({ command: [daemon!] });
					const env = yield* Remote.make({ connection, id: "pi-env:test", cwd: directory });
					const fiber = yield* Effect.forkChild(env.exec("exec sleep 30"), { startImmediately: true });
					yield* Fiber.interrupt(fiber);
					return yield* Fiber.await(fiber);
				}),
			);
			expect(Exit.hasInterrupts(exit)).toBe(true);
		});

		it("fails file operations with FileFailed carrying the daemon's code", async () => {
			const exit = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const connection = yield* Connection.make({ command: [daemon!] });
					const services = yield* Layer.build(Remote.layer({ connection, id: "pi-env:test", cwd: directory }));
					return yield* Effect.exit(Context.get(services, Env.Current).readTextFile("missing"));
				}),
			);
			expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
				error: { _tag: "FileFailed", code: "not_found" },
			});
		});
	},
);
