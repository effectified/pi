import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { runLive } from "@effectified/pi-ai/testing";
import { Context, Effect, Layer, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import * as NodeEnv from "../src/env/node.ts";
import { Extension, Registry } from "../src/index.ts";
import { answer, TestHarness, toolCall } from "../src/testing/index.ts";
import * as Tools from "../src/tools.ts";

const root = mkdtempSync(join(tmpdir(), "durable-effect-tools-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What `bash`'s preparation reads: a service, so the test sees it ran with the registry's services. */
class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}

/** The texts of the tool results the model was given, in order. */
const results = Effect.gen(function* () {
	const conversation = yield* TestHarness.root;
	const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
	return entries
		.filter((entry) => entry.kind === "pi.tool-result")
		.map((entry) => {
			const content = entry.model?.[0]?.content ?? [];
			return typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : part.type)).join("");
		});
});

describe("the coding tools", () => {
	it("write, read, edit and run commands in the conversation's environment", async () => {
		const directory = mkdtempSync(join(root, "coding-"));
		const texts = await runLive(
			Effect.gen(function* () {
				const env = yield* NodeEnv.make({ cwd: directory });
				return yield* Effect.gen(function* () {
					const conversation = yield* TestHarness.root;
					yield* conversation.prompt("Code.");
					return yield* results;
				}).pipe(
					Effect.provide(
						TestHarness.layer({
							extensions: [
								Extension.make({
									name: "coding-tools",
									tools: [
										Tools.read(),
										Tools.write,
										Tools.edit,
										Tools.bash({
											prepare: (execution) =>
												Greeting.use(({ text }) =>
													Effect.sync(() => {
														execution.env.GREETING = text;
													}),
												),
										}),
									],
								}),
							],
							harness: { env: () => env },
							responses: [
								toolCall("write", { path: "note.txt", content: "one\ntwo\n" }),
								toolCall("edit", { path: "note.txt", edits: [{ oldText: "two", newText: "three" }] }),
								toolCall("read", { path: "note.txt" }),
								toolCall("bash", { command: 'echo "$GREETING"' }),
								answer("Done."),
							],
						}),
					),
					Effect.provide(Layer.succeed(Greeting, { text: "hello from Effect" })),
				);
			}),
		);
		expect(readFileSync(join(directory, "note.txt"), "utf8")).toBe("one\nthree\n");
		expect(texts[2]).toContain("one\nthree");
		expect(texts[3]).toContain("hello from Effect");
	});

	it("coding is Pi's coding-tools extension: the same name and tools", () => {
		const ours = Tools.coding();
		expect([ours.name, ours.tools?.map((tool) => tool.name)]).toEqual([
			CodingTools.name,
			CodingTools.tools?.map((tool) => tool.name),
		]);
	});

	it("installs in a registry beside extensions of this package", async () => {
		const installed = await Effect.runPromise(
			Registry.Registry.use((registry) =>
				Effect.sync(() =>
					registry
						.snapshot()
						.tools()
						.map(({ tool }) => tool.name),
				),
			).pipe(Effect.provide(Registry.layer([Tools.coding(), { name: "shell", tools: [Tools.powershell()] }]))),
		);
		expect(installed).toEqual(["read", "write", "edit", "bash", "powershell"]);
	});
});
