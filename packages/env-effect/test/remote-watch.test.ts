import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Connection from "../src/node/connection.ts";
import * as RemoteWatch from "../src/node/remote-watch.ts";
import { daemon, NO_DAEMON, tempDir } from "./fixtures.ts";

describe.skipIf(daemon === undefined)(`RemoteWatch (${daemon ?? NO_DAEMON})`, () => {
	it("reports a change made after the daemon's watcher opened", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [daemon!] });
				const watcher = yield* RemoteWatch.open(connection, [{ path: directory, recursive: true }]);
				writeFileSync(join(directory, "new.txt"), "x");
				return { mode: yield* watcher.mode, change: yield* Stream.runHead(watcher.changes) };
			}),
		);
		expect(seen.change).toMatchObject({ _tag: "Some", value: { kind: "paths" } });
		expect(["native", "polling"]).toContain(seen.mode);
	});

	it("fails with RemoteFailed when the daemon cannot start", async () => {
		const exit = await runLive(
			Effect.gen(function* () {
				const directory = yield* tempDir;
				const connection = yield* Connection.make({ command: [join(directory, "no-daemon")] });
				return yield* Effect.exit(RemoteWatch.open(connection, [{ path: directory }]));
			}),
		);
		expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
			error: { _tag: "RemoteFailed", code: "spawn_error" },
		});
	});
});
