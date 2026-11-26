import { runTest } from "@effectified/pi-ai/testing";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Command, Extension, ExtensionApi } from "../src/index.ts";
import { openSession, services } from "./scripted.ts";

/** The data of the custom entries of `customType` in a session's entries. */
function customData(entries: ReadonlyArray<{ readonly type: string }>, customType: string): unknown[] {
	return entries.flatMap((entry) =>
		entry.type === "custom" && "customType" in entry && entry.customType === customType && "data" in entry
			? [entry.data]
			: [],
	);
}

/** A session whose one extension has the command `/run`, running `effect` with the extension API. */
function withCommand<A>(effect: Effect.Effect<A, unknown, ExtensionApi>) {
	return openSession({
		extensions: [
			Extension.make("api", {
				commands: [
					Command.make("run", {
						handler: () =>
							Effect.gen(function* () {
								const api = yield* ExtensionApi;
								yield* api.appendEntry("result", yield* effect);
							}),
					}),
				],
			}),
		],
	});
}

describe("ExtensionApi", () => {
	it("runs a program to its end with exec, its output and exit code a result", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session } = yield* withCommand(
					Effect.flatMap(ExtensionApi, (api) =>
						api.exec(process.execPath, ["-e", "process.stdout.write('from exec'); process.exit(3)"]),
					),
				);
				yield* session.prompt("/run");
				return customData(yield* session.sessionManager.getEntries(), "result");
			}).pipe(Effect.provide(services)),
		);
		expect(results).toMatchObject([{ stdout: "from exec", code: 3 }]);
	});

	it("sends on the bus the session's extensions share, and streams what is sent on a channel", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session } = yield* withCommand(
					Effect.gen(function* () {
						const api = yield* ExtensionApi;
						const receiving = yield* Effect.forkChild(Stream.runCollect(Stream.take(api.events("ping"), 1)), {
							startImmediately: true,
						});
						yield* api.emit("ping", { n: 1 });
						return yield* Fiber.join(receiving);
					}),
				);
				yield* session.prompt("/run");
				return customData(yield* session.sessionManager.getEntries(), "result");
			}).pipe(Effect.provide(services)),
		);
		expect(results).toEqual([[{ n: 1 }]]);
	});

	it("reads and changes the session: its name and its active tools", async () => {
		const results = await runTest(
			Effect.gen(function* () {
				const { session } = yield* withCommand(
					Effect.gen(function* () {
						const api = yield* ExtensionApi;
						yield* api.setSessionName("renamed");
						yield* api.setActiveTools(["read", "bash"]);
						return { name: yield* api.getSessionName(), tools: yield* api.getActiveTools() };
					}),
				);
				yield* session.prompt("/run");
				return customData(yield* session.sessionManager.getEntries(), "result");
			}).pipe(Effect.provide(services)),
		);
		expect(results).toEqual([{ name: "renamed", tools: ["read", "bash"] }]);
	});
});
