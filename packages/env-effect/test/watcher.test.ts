import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileError } from "@earendil-works/pi-durable/env";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Call from "../src/call.ts";
import { fromFileError } from "../src/errors.ts";
import * as Watcher from "../src/watcher.ts";
import { nodeEnv, tempDir } from "./fixtures.ts";

describe("Watcher.acquire", () => {
	it("reports a change made after it opened, through Pi's Node watcher", async () => {
		const change = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const env = nodeEnv(directory);
				const watcher = yield* Watcher.acquire((onChange) =>
					Call.result(
						(context) => env.watch([{ path: directory, recursive: true }], onChange, context),
						fromFileError,
					),
				);
				writeFileSync(join(directory, "new.txt"), "x");
				return yield* Stream.runHead(watcher.changes);
			}),
		);
		expect(change).toMatchObject({ _tag: "Some", value: { kind: "paths" } });
	});

	it("ends its changes when the scope closes, after stopping Pi's watcher", async () => {
		const result = await runLive(
			Effect.gen(function* () {
				let stopped = false;
				const scope = yield* Scope.make();
				const watcher = yield* Scope.provide(
					Watcher.acquire(() =>
						Effect.succeed({
							mode: "polling" as const,
							stop: async () => {
								stopped = true;
							},
						}),
					),
					scope,
				);
				yield* Scope.close(scope, Exit.void);
				return { stopped, changes: yield* Stream.runCollect(watcher.changes), mode: yield* watcher.mode };
			}),
		);
		expect(result).toEqual({ stopped: true, changes: [], mode: "polling" });
	});

	it("keeps changes until they are read, and fails with Pi's `failed` change, after which nothing follows", async () => {
		const seen: Watcher.WatchChange[] = [];
		const exit = await runLive(
			Effect.gen(function* () {
				const watcher = yield* Watcher.acquire((onChange) =>
					Effect.sync(() => {
						onChange({ kind: "paths", paths: ["/a"] });
						onChange({ kind: "overflow" });
						onChange({ kind: "failed", error: new FileError("invalid", "too many directories") });
						onChange({ kind: "paths", paths: ["/b"] });
						return { mode: "native" as const, stop: async () => {} };
					}),
				);
				return yield* Effect.exit(
					Stream.runCollect(Stream.tap(watcher.changes, (change) => Effect.sync(() => seen.push(change)))),
				);
			}),
		);
		expect(seen).toEqual([{ kind: "paths", paths: ["/a"] }, { kind: "overflow" }]);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "FileFailed", code: "invalid", message: "too many directories" },
		});
	});
});
