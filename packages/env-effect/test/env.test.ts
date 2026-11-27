import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Context, Effect, Exit, Fiber, Layer, Option, Scope, Stream, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import * as Env from "../src/env.ts";
import { nodeEnv, tempDir } from "./fixtures.ts";

describe("Env.fromPi", () => {
	it("puts every file operation of Pi's environment in Effect terms", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = yield* Env.fromPi(nodeEnv(directory));
				yield* env.createDir("dir/sub", { recursive: true });
				yield* env.writeFile("dir/a.txt", "one\n");
				yield* env.appendFile("dir/a.txt", new TextEncoder().encode("two\n"));
				yield* env.flushFile("dir/a.txt");
				yield* env.renameFile("dir/a.txt", "dir/b.txt");
				const text = yield* env.readTextFile("dir/b.txt");
				const lines = yield* env.readTextLines("dir/b.txt", { maxLines: 1 });
				yield* env.truncateFile("dir/b.txt", 3);
				const bytes = new TextDecoder().decode(yield* env.readBinaryFile("dir/b.txt"));
				const info = yield* env.fileInfo("dir/b.txt");
				const listed = (yield* env.listDir("dir")).map((entry) => entry.name).sort();
				const temporary = yield* env.createTempFile({ prefix: "t-", suffix: ".txt" });
				const temporaryDir = yield* env.createTempDir("d-");
				const exists = [yield* env.exists("dir/b.txt"), yield* env.exists("dir/a.txt")];
				yield* env.remove("dir", { recursive: true });
				yield* env.remove(temporary);
				yield* env.remove(temporaryDir, { recursive: true });
				return {
					id: env.id,
					cwd: (yield* env.cwd) === directory,
					absolute: yield* env.absolutePath("x"),
					joined: yield* env.joinPath(["a", "b"]),
					canonical: yield* env.canonicalPath("."),
					text,
					lines,
					bytes,
					size: info.size,
					listed,
					temporary: existsSync(temporary),
					exists,
					gone: yield* env.exists("dir"),
				};
			}).pipe(
				Effect.map((seen) => ({
					...seen,
					absolute: seen.absolute.endsWith("/x"),
					canonical: seen.canonical.length > 0,
				})),
			),
		);
		expect(seen).toEqual({
			id: "node:local",
			cwd: true,
			absolute: true,
			joined: "a/b",
			canonical: true,
			text: "one\ntwo\n",
			lines: ["one"],
			bytes: "one",
			size: 3,
			listed: ["b.txt", "sub"],
			temporary: false,
			exists: [true, false],
			gone: false,
		});
	});

	it("fails with FileFailed carrying Pi's code and path", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.flatMap(Env.fromPi(nodeEnv(directory)), (env) => Effect.exit(env.readTextFile("missing.txt"))),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "FileFailed", code: "not_found" },
		});
	});

	it("lists files only where the environment can: Pi's Node environment cannot, so `not_supported`", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.flatMap(Env.fromPi(nodeEnv(directory)), (env) => Effect.exit(env.listFiles("."))),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "FileFailed", code: "not_supported" },
		});
	});

	it("gives Pi's environment itself, for a harness", async () => {
		const pi = nodeEnv("/");
		expect((await runLive(Env.fromPi(pi))).pi).toBe(pi);
	});

	it("runs each operation in a span named for it, under the caller's span", async () => {
		const spans: Tracer.NativeSpan[] = [];
		const tracer = Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		});
		await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = yield* Env.fromPi(nodeEnv(directory));
				yield* Effect.withSpan(env.exists("x"), "app.check");
				yield* Effect.withSpan(Stream.runDrain(env.execOutput("true")), "app.run");
			}).pipe(Effect.provideService(Tracer.Tracer, tracer)),
		);
		const parent = (name: string) => {
			const span = spans.find((each) => each.name === name);
			const parentId = span === undefined ? undefined : Option.getOrUndefined(span.parent)?.spanId;
			return spans.find((each) => each.spanId === parentId)?.name;
		};
		expect([parent("Env.exists"), parent("Env.execOutput")]).toEqual(["app.check", "app.run"]);
	});

	it("runs commands, streams output and watches, through the same environment", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = yield* Env.fromPi(nodeEnv(directory));
				const watcher = yield* env.watch([{ path: ".", recursive: true }]);
				const result = yield* env.exec("echo hi > hi.txt");
				const change = yield* Stream.runHead(watcher.changes);
				const output = yield* Stream.runCollect(env.execOutput("cat hi.txt"));
				const lines = yield* Stream.runCollect(env.textLines("hi.txt"));
				const entries = yield* Stream.runCollect(env.dirEntries(".", 10));
				const reader = yield* env.binaryReader("hi.txt");
				return {
					result,
					change: change._tag,
					output,
					lines,
					entries: entries.length,
					size: (yield* reader.info).size,
				};
			}),
		);
		expect(seen).toEqual({
			result: { exitCode: 0 },
			change: "Some",
			output: [
				{ kind: "output", text: "hi\n", stream: "stdout" },
				{ kind: "exited", exitCode: 0 },
			],
			lines: [{ text: "hi", terminated: true }],
			entries: 1,
			size: 3,
		});
	});
});

describe.skipIf(process.platform === "win32")("Env.layer", () => {
	it("provides Env.Current and kills the commands still running when it is released", async () => {
		const { pid, exit } = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const scope = yield* Scope.make();
				const services = yield* Layer.buildWithScope(Env.layer(Effect.sync(() => nodeEnv(directory))), scope);
				const env = Context.get(services, Env.Current);
				const command = yield* Effect.forkDetach(env.exec("echo $$ > pid; exec sleep 30"));
				const file = join(directory, "pid");
				yield* Effect.repeat(
					Effect.sync(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n")),
					{ until: (written) => written },
				);
				yield* Scope.close(scope, Exit.void);
				return { pid: Number(readFileSync(file, "utf8")), exit: yield* Fiber.await(command) };
			}),
		);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(Exit.isSuccess(exit) && exit.value.exitCode !== 0).toBe(true);
	});
});

describe("Env.owned", () => {
	it("cleans Pi's environment up when the scope closes", async () => {
		const cleaned = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const pi = nodeEnv(directory);
				let cleanups = 0;
				const cleanup = pi.cleanup.bind(pi);
				pi.cleanup = (context) => {
					cleanups++;
					return cleanup(context);
				};
				yield* Effect.scoped(Env.owned(Effect.succeed(pi)));
				return cleanups;
			}),
		);
		expect(cleaned).toBe(1);
	});
});
