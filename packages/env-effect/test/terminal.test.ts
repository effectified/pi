import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Option, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Connection from "../src/node/connection.ts";
import * as Terminal from "../src/node/terminal.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

const text = (chunks: ReadonlyArray<Uint8Array>) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

describe.skipIf(daemon === undefined || process.platform === "win32")(`Terminal (${daemon ?? NO_DAEMON})`, () => {
	it("runs a program in a pseudo-terminal: size, input, raw output and its exit", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const terminal = yield* Terminal.open(connection, {
					cwd: directory,
					argv: ["sh", "-c", 'read line; stty size; echo "got $line"; exit 2'],
					cols: 80,
					rows: 24,
				});
				const foreground = yield* terminal.foreground;
				yield* terminal.resize(100, 30);
				yield* terminal.write("hello\n");
				return {
					foreground,
					output: text(yield* Stream.runCollect(terminal.output)),
					exited: yield* terminal.exited,
				};
			}),
		);
		expect(seen.foreground).toEqual(Option.none());
		expect(seen.output).toContain("30 100");
		expect(seen.output).toContain("got hello");
		expect(seen.exited).toBe(2);
	});

	it("kills the program when the scope closes", async () => {
		const exited = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const scope = yield* Scope.make();
				const terminal = yield* Scope.provide(
					Terminal.open(connection, { cwd: directory, argv: ["sleep", "30"], cols: 80, rows: 24 }),
					scope,
				);
				yield* Scope.close(scope, Exit.void);
				return yield* Effect.exit(terminal.exited);
			}),
		);
		expect(Exit.isFailure(exited) && exited.cause.reasons[0]).toMatchObject({ error: { code: "aborted" } });
	});
});
