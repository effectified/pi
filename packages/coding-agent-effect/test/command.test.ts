import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Command, CommandContext, Extension, ExtensionApi } from "../src/index.ts";
import { openSession, services } from "./scripted.ts";

/** A failure of a command's handler, as an extension would have one. */
class CommandFailed extends Schema.TaggedError<CommandFailed, { readonly brand: unique symbol }>()("CommandFailed", {
	message: Schema.String,
}) {}

describe("Command.make", () => {
	it("registers `/name` with its description and completions, which run as Effects", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const deploy = Command.make("deploy", {
					description: "Deploys an environment.",
					getArgumentCompletions: (prefix) =>
						Effect.succeed(
							["staging", "production"]
								.filter((name) => name.startsWith(prefix))
								.map((value) => ({ value, label: value })),
						),
					handler: () => Effect.void,
				});
				const { session } = yield* openSession({
					extensions: [Extension.make("deployer", { commands: [deploy] })],
				});
				// What Pi registered, read from the session's own extension runner.
				const registered = session.pi.extensionRunner.getCommand("deploy");
				const completions = yield* Effect.promise(async () => registered?.getArgumentCompletions?.("st"));
				return { description: registered?.description, completions };
			}).pipe(Effect.provide(services)),
		);
		expect(seen).toEqual({
			description: "Deploys an environment.",
			completions: [{ value: "staging", label: "staging" }],
		});
	});

	it("runs its handler with the command's context: the session's system prompt options", async () => {
		const cwd = await runTest(
			Effect.gen(function* () {
				const seen: string[] = [];
				const where = Command.make("where", {
					handler: () =>
						Effect.gen(function* () {
							const options = yield* (yield* CommandContext).getSystemPromptOptions;
							seen.push(options.cwd ?? "");
						}),
				});
				const { session, dir } = yield* openSession({
					extensions: [Extension.make("where", { commands: [where] })],
				});
				yield* session.prompt("/where");
				return { seen, dir };
			}).pipe(Effect.provide(services)),
		);
		expect(cwd.seen).toEqual([cwd.dir]);
	});

	it("reports a failing handler as an extension error with its message", async () => {
		const errors = await runTest(
			Effect.gen(function* () {
				const broken = Command.make("broken", {
					handler: () => Effect.fail(CommandFailed.make({ message: "the command failed" })),
				});
				const { session } = yield* openSession({ extensions: [Extension.make("broken", { commands: [broken] })] });
				const reported = yield* session.extensionErrors;
				yield* session.prompt("/broken");
				return yield* reported.pipe(Stream.take(1), Stream.runCollect);
			}).pipe(Effect.provide(services)),
		);
		expect(errors).toMatchObject([{ error: "the command failed" }]);
	});

	it("is registered while the session runs through the extension API", async () => {
		const names = await runTest(
			Effect.gen(function* () {
				const late = Command.make("late", { handler: () => Effect.void });
				const adder = Command.make("add-late", {
					handler: () => Effect.flatMap(ExtensionApi, (api) => api.registerCommand(late)),
				});
				const { session } = yield* openSession({ extensions: [Extension.make("adder", { commands: [adder] })] });
				yield* session.prompt("/add-late");
				return session.pi.extensionRunner.getRegisteredCommands().map((command) => command.name);
			}).pipe(Effect.provide(services)),
		);
		expect(names).toEqual(["add-late", "late"]);
	});
});
