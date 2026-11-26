import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Context, Effect, Exit, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Env from "../src/env.ts";
import * as Connection from "../src/node/connection.ts";
import * as Local from "../src/node/local.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

describe.skipIf(process.platform === "win32")("Local, without a daemon", () => {
	it("runs commands and file operations on this machine; the daemon starts only for listFiles", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [join(directory, "no-daemon")] });
				const env = yield* Local.make({ cwd: directory, connection });
				yield* env.writeFile("a.txt", "a");
				const result = yield* env.exec("cat a.txt");
				const output = yield* Stream.runCollect(env.execOutput("cat a.txt"));
				const listed = yield* Effect.exit(env.listFiles("."));
				return { id: env.id, result, output: output[0], listed };
			}),
		);
		expect(seen).toMatchObject({
			id: "node:local",
			result: { exitCode: 0 },
			output: { kind: "output", text: "a" },
		});
		expect(Exit.isFailure(seen.listed) && seen.listed.cause.reasons[0]).toMatchObject({
			error: { _tag: "FileFailed" },
		});
	});
});

describe.skipIf(daemon === undefined)(`Local, with this machine's daemon (${daemon ?? NO_DAEMON})`, () => {
	it("lists files through the daemon, skipping excluded names", async () => {
		const listing = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				mkdirSync(join(directory, "src"));
				mkdirSync(join(directory, "node_modules"));
				writeFileSync(join(directory, "src/a.ts"), "");
				writeFileSync(join(directory, "node_modules/b.js"), "");
				const connection = yield* Connection.make({ command: [daemon!] });
				const env = yield* Local.make({ cwd: directory, connection });
				return yield* env.listFiles(".", { exclude: ["node_modules"] });
			}),
		);
		expect(listing).toEqual({
			entries: [
				{ path: "src", kind: "directory" },
				{ path: "src/a.ts", kind: "file" },
			],
			truncated: false,
		});
	});

	it("provides Env.Current as a Layer", async () => {
		const id = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const services = yield* Layer.build(Local.layer({ cwd: directory, connection }));
				return Context.get(services, Env.Current).id;
			}),
		);
		expect(id).toBe("node:local");
	});
});
