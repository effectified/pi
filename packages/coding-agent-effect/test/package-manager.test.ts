import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { PackageManager, SettingsManager } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

describe("PackageManager.make", () => {
	it("adds a local package to the settings and resolves its resources, without installing anything", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const local = join(dir, "tools");
				mkdirSync(join(local, "extensions"), { recursive: true });
				writeFileSync(join(local, "extensions", "hello.js"), "export default () => {};\n");
				const packages = yield* PackageManager.make({
					cwd: dir,
					agentDir: join(dir, "agent"),
					settingsManager: yield* SettingsManager.inMemory(),
				});
				const added = yield* packages.addSourceToSettings(local);
				const configured = yield* packages.listConfiguredPackages();
				const resolved = yield* packages.resolve(() => Effect.succeed("skip"));
				return {
					added,
					configured: configured.map((entry) => entry.source),
					extensions: resolved.extensions.map((resource) => resource.path),
				};
			}),
		);
		expect(seen.added).toBe(true);
		expect(seen.configured).toHaveLength(1);
		expect(seen.extensions).toEqual([expect.stringMatching(/tools[/\\]extensions[/\\]hello\.js$/)]);
	});
});
