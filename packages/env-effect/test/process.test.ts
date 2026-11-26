import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Connection from "../src/node/connection.ts";
import * as Process from "../src/node/process.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

const text = (chunks: ReadonlyArray<Uint8Array>) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

describe.skipIf(daemon === undefined || process.platform === "win32")(`Process (${daemon ?? NO_DAEMON})`, () => {
	it("pipes input to a program and its stdout and stderr back, apart, until it exits", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const program = yield* Process.open(connection, {
					cwd: directory,
					argv: ["sh", "-c", 'read line; echo "got $line"; echo oops >&2; exit 4'],
				});
				yield* program.write("ping\n");
				yield* program.closeStdin;
				return {
					pid: program.pid,
					stdout: text(yield* Stream.runCollect(program.stdout)),
					stderr: text(yield* Stream.runCollect(program.stderr)),
					exited: yield* program.exited,
				};
			}),
		);
		expect(seen.pid).toBeGreaterThan(0);
		expect(seen).toMatchObject({ stdout: "got ping\n", stderr: "oops\n", exited: 4 });
	});

	it("kills the program and its process group when the scope closes", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const scope = yield* Scope.make();
				const program = yield* Scope.provide(
					Process.open(connection, { cwd: directory, argv: ["sh", "-c", "sleep 30 & echo $! > child; wait"] }),
					scope,
				);
				const file = join(directory, "child");
				yield* Effect.repeat(
					Effect.sync(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n")),
					{ until: (written) => written },
				);
				yield* Scope.close(scope, Exit.void);
				return { child: Number(readFileSync(file, "utf8")), exited: yield* Effect.exit(program.exited) };
			}),
		);
		expect(() => process.kill(seen.child, 0)).toThrow();
		expect(Exit.isFailure(seen.exited) && seen.exited.cause.reasons[0]).toMatchObject({ error: { code: "aborted" } });
	});

	it("fails the open with RemoteFailed when the program cannot start", async () => {
		const exit = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				return yield* Effect.exit(Process.open(connection, { cwd: directory, argv: [join(directory, "missing")] }));
			}),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({ error: { _tag: "RemoteFailed" } });
	});
});
