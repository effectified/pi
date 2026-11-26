import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { exec, execOutput } from "../src/exec.ts";
import { nodeEnv, tempDir } from "./fixtures.ts";

/** Whether a process with this pid still runs. */
function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("exec", () => {
	it("runs a shell command in the environment's directory to its exit", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = nodeEnv(directory);
				const result = yield* exec(env, "printf hi > out.txt; exit 3");
				return { result, written: readFileSync(join(directory, "out.txt"), "utf8") };
			}),
		);
		expect(result).toEqual({ result: { exitCode: 3 }, written: "hi" });
	});

	it("runs an argv command without a shell", async () => {
		const exitCode = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.map(exec(nodeEnv(directory), ["sh", "-c", "exit $0", "5"]), (result) => result.exitCode),
			),
		);
		expect(exitCode).toBe(5);
	});

	it("fails with ExecFailed where Pi refuses the command", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) => Effect.exit(exec(nodeEnv(directory), "true", { timeout: -1 }))),
		);
		expect(exit).toMatchObject({ _tag: "Failure" });
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "ExecFailed", code: "timeout" },
		});
	});

	it("kills the command when its fiber is interrupted, and waits until it is gone", async () => {
		const pid = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = nodeEnv(directory);
				const fiber = yield* Effect.forkChild(exec(env, "echo $$ > pid; exec sleep 30"), {
					startImmediately: true,
				});
				// The shell wrote its pid: the command runs.
				const file = join(directory, "pid");
				yield* Effect.repeat(
					Effect.sync(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n")),
					{ until: (written) => written },
				);
				const pid = Number(readFileSync(file, "utf8"));
				yield* Fiber.interrupt(fiber);
				return pid;
			}),
		);
		expect(running(pid)).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("execOutput", () => {
	it("streams stdout and stderr in arrival order and ends with the exit", async () => {
		const events = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Stream.runCollect(
					execOutput(nodeEnv(directory), "echo one; sleep 0.05; echo two >&2; sleep 0.05; echo three; exit 1"),
				),
			),
		);
		expect(events).toEqual([
			{ kind: "output", text: "one\n", stream: "stdout" },
			{ kind: "output", text: "two\n", stream: "stderr" },
			{ kind: "output", text: "three\n", stream: "stdout" },
			{ kind: "exited", exitCode: 1 },
		]);
	});

	it("kills the command when the stream ends early", async () => {
		const pid = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const first = yield* Stream.runHead(execOutput(nodeEnv(directory), "echo $$; exec sleep 30"));
				return first._tag === "Some" && first.value.kind === "output" ? Number(first.value.text) : -1;
			}),
		);
		expect(pid).toBeGreaterThan(0);
		expect(running(pid)).toBe(false);
	});

	it("fails the stream with ExecFailed", async () => {
		const exit = await runLive(
			Effect.flatMap(tempDir, (directory) =>
				Effect.exit(Stream.runCollect(execOutput(nodeEnv(directory), "true", { timeout: 0 }))),
			),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "ExecFailed", code: "timeout" },
		});
	});
});
