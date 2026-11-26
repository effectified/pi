import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { runLive } from "@effectified/pi-ai/testing";
import { Env } from "@effectified/pi-env";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { Builtin } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

/** The text of a tool result. */
function text(result: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }): string {
	return result.content
		.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
		.join("");
}

describe("Builtin tools", () => {
	it("run Pi's write, read, edit and ls in their working directory as Effects", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				yield* Builtin.write(dir).run({ path: "notes.txt", content: "one\ntwo\n" });
				yield* Builtin.edit(dir).run({ path: "notes.txt", edits: [{ oldText: "two", newText: "three" }] });
				return {
					read: text(yield* Builtin.read(dir).run({ path: "notes.txt" })),
					listed: text(yield* Builtin.ls(dir).run({})),
					file: readFileSync(join(dir, "notes.txt"), "utf8"),
				};
			}),
		);
		expect(seen.file).toBe("one\nthree\n");
		expect(seen.read).toContain("three");
		expect(seen.listed).toContain("notes.txt");
	});

	it("give Pi's definitions and agent tools, under Pi's names and in Pi's sets", async () => {
		const names = await runLive(
			Effect.gen(function* () {
				const coding = Builtin.coding("/project").map((tool) => tool.name);
				const readOnly = Builtin.readOnly("/project").map((tool) => tool.name);
				const definition = yield* Builtin.bash("/project").definition;
				const agentTool = yield* Builtin.bash("/project").agentTool;
				return { coding, readOnly, definition: definition.name, agentTool: agentTool.name };
			}),
		);
		expect(names).toEqual({
			coding: ["read", "bash", "edit", "write"],
			readOnly: ["read", "grep", "find", "ls"],
			definition: "bash",
			agentTool: "bash",
		});
	});

	it("fail with Pi's error as a CodingAgentError: reading a file that does not exist", async () => {
		const failure = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				return yield* Effect.flip(Builtin.read(dir).run({ path: "missing.txt" }));
			}),
		);
		expect(failure._tag).toBe("CodingAgentError");
		expect(failure.message).toContain("missing.txt");
	});
});

describe("Builtin.bashOperations", () => {
	it("runs bash's commands in an execution environment of @effectified/pi-env", async () => {
		const output = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const env = yield* Env.fromPi(new NodeExecutionEnv({ cwd: dir }));
				const bash = Builtin.bash(dir, { operations: Builtin.bashOperations(env) });
				return text(yield* bash.run({ command: "echo from-env && pwd" }));
			}),
		);
		expect(output).toContain("from-env");
	});

	it("reaches bash's timeout as Pi's own shell reports it", async () => {
		const failure = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const env = yield* Env.fromPi(new NodeExecutionEnv({ cwd: dir }));
				const bash = Builtin.bash(dir, { operations: Builtin.bashOperations(env) });
				return yield* Effect.flip(bash.run({ command: "sleep 5", timeout: 1 }));
			}),
		);
		expect(failure.message).toContain("timed out after 1 second");
	});
});

describe("Builtin.withFileMutationQueue", () => {
	it("runs a mutation of a file after the one queued before it, and fails as the Effect does", async () => {
		const order = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const file = join(dir, "queued.txt");
				const order: string[] = [];
				const release = yield* Deferred.make<void>();
				const first = yield* Effect.forkChild(
					Builtin.withFileMutationQueue(
						file,
						Effect.andThen(
							Deferred.await(release),
							Effect.sync(() => order.push("first")),
						),
					),
					{ startImmediately: true },
				);
				const second = yield* Effect.forkChild(
					Builtin.withFileMutationQueue(
						file,
						Effect.sync(() => order.push("second")),
					),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				const failed = yield* Effect.flip(Builtin.withFileMutationQueue(file, Effect.fail("refused" as const)));
				return { order, failed };
			}),
		);
		expect(order).toEqual({ order: ["first", "second"], failed: "refused" });
	});
});
