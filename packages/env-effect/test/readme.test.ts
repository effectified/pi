// The examples of README.md, run as they stand: on this machine, with the daemon of this checkout where they start
// one, and through a stand-in for `ssh` where they reach a remote machine.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Connection, HostKey, Local, Process, Remote, Ssh, Terminal } from "../src/node.ts";
import { fakeSsh } from "./fake-ssh.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

// README: A local environment.
const local = (cwd: string) =>
	Effect.gen(function* () {
		// This machine's daemon, for `listFiles`; several environments may share the connection.
		const connection = yield* Connection.make({ command: [yield* Ssh.local] });
		const env = yield* Local.make({ cwd, connection });

		yield* env.writeFile("notes/today.txt", "one\ntwo\n");
		// A non-zero exit code is a result, not a failure.
		const { exitCode } = yield* env.exec("grep -q three notes/today.txt");
		// The output as it arrives, then the exit.
		const output = yield* Stream.runCollect(env.execOutput(["cat", "notes/today.txt"]));
		const lines = yield* Stream.runCollect(env.textLines("notes/today.txt"));
		return { exitCode, output, lines };
	});

// README: Interruption and failures.
const interrupted = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });
		const env = yield* Local.make({ cwd, connection });

		const sleeping = yield* Effect.forkChild(env.exec("sleep 30"), { startImmediately: true });
		// Returns once the command's processes are gone.
		yield* Fiber.interrupt(sleeping);

		const missing = yield* env
			.readTextFile("missing.txt")
			.pipe(Effect.catchTag("FileFailed", (error) => Effect.succeed(`${error.code}: ${error.path}`)));
		const listing = yield* env.listFiles(".", { exclude: ["node_modules"] });
		return { missing, entries: listing.entries.length };
	});

// README: Processes and terminals.
const programs = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });

		const server = yield* Process.open(connection, {
			cwd,
			argv: ["sh", "-c", 'read request; echo "answer to $request"'],
		});
		yield* server.write("ping\n");
		const answer = yield* server.stdout.pipe(Stream.decodeText(), Stream.mkString);

		const terminal = yield* Terminal.open(connection, { cwd, argv: ["sh", "-c", "stty size"], cols: 100, rows: 30 });
		const screen = yield* terminal.output.pipe(Stream.decodeText(), Stream.mkString);
		return { answer, exitCode: yield* server.exited, screen, terminalExit: yield* terminal.exited };
	});

// README: Watching files.
const watching = (cwd: string, daemon: string) =>
	Effect.gen(function* () {
		const connection = yield* Connection.make({ command: [daemon] });
		const env = yield* Local.make({ cwd, connection });
		const watcher = yield* env.watch([{ path: ".", recursive: true }]);
		yield* env.writeFile("changed.txt", "x");
		// `paths` changes until the scope closes; Pi's `failed` change fails the stream.
		return yield* Stream.runHead(watcher.changes);
	});

// README: A remote machine over SSH.
const trust = (target: Ssh.ConnectOptions) =>
	Effect.gen(function* () {
		const { lines, fingerprints } = yield* HostKey.scan(target);
		// Show `fingerprints` to the owner; accept only what they confirmed.
		yield* HostKey.accept(target, lines);
		return fingerprints;
	});

const remote = (target: Ssh.ConnectOptions, cwd: string) =>
	Effect.gen(function* () {
		const { connection, remote } = yield* Ssh.connect(target);
		const env = yield* Remote.make({ connection, id: `pi-env:${target.hostKeyAlias}`, cwd });
		const { exitCode } = yield* env.exec("test -d .");
		return { platform: remote.platform, exitCode };
	});

describe.skipIf(process.platform === "win32")("README", () => {
	it("A local environment", async () => {
		const result = await runLive(Effect.flatMap(tempDir, local));
		expect(result).toEqual({
			exitCode: 1,
			output: [
				{ kind: "output", text: "one\ntwo\n", stream: "stdout" },
				{ kind: "exited", exitCode: 0 },
			],
			lines: [
				{ text: "one", terminated: true },
				{ text: "two", terminated: true },
			],
		});
	});

	describe.skipIf(daemon === undefined)(`with the daemon of this checkout (${daemon ?? NO_DAEMON})`, () => {
		it("Interruption and failures", async () => {
			const { directory, result } = await runLive(
				Effect.flatMap(tempDir, (directory) =>
					Effect.map(interrupted(directory, daemon!), (result) => ({ directory, result })),
				),
			);
			// Pi names the absolute path.
			expect(result).toEqual({ missing: `not_found: ${join(directory, "missing.txt")}`, entries: 0 });
		});

		it("Processes and terminals", async () => {
			const result = await runLive(Effect.flatMap(tempDir, (directory) => programs(directory, daemon!)));
			expect(result).toEqual({ answer: "answer to ping\n", exitCode: 0, screen: "30 100\r\n", terminalExit: 0 });
		});

		it("Watching files", async () => {
			const change = await runLive(Effect.flatMap(tempDir, (directory) => watching(directory, daemon!)));
			expect(change).toMatchObject({ _tag: "Some", value: { kind: "paths" } });
		});

		it("A remote machine over SSH, through a stand-in for ssh", async () => {
			const result = await runLive(
				Effect.gen(function* () {
					const directory = yield* tempDir;
					const scanning = fakeSsh(directory, directory, "scan");
					const fingerprints = yield* trust(scanning);
					const target = { ...fakeSsh(directory, directory, "run"), binary: daemon! };
					return {
						fingerprints: fingerprints.length,
						trusted: existsSync(scanning.knownHostsFile),
						...(yield* remote(target, directory)),
					};
				}),
			);
			expect(result).toEqual({ fingerprints: 1, trusted: true, platform: process.platform, exitCode: 0 });
		});
	});
});
