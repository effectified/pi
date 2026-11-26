import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive, runTest } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	discoverAndLoadExtensions,
	Extension,
	loadProjectContextFiles,
	ResourceLoader,
	SettingsManager,
} from "../src/index.ts";
import { tempDir } from "./scripted.ts";

/** An extension file Pi loads from a path: a default export that registers a command. */
const EXTENSION_FILE = 'export default (pi) => { pi.registerCommand("from-file", { handler: async () => {} }); };\n';

describe("ResourceLoader.make", () => {
	it("loads Pi's inline extensions and the extensions written in Effect, in that order", async () => {
		const paths = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const loader = yield* ResourceLoader.make({
					cwd: dir,
					agentDir: dir,
					settingsManager: yield* SettingsManager.inMemory(),
					extensionFactories: [{ name: "plain", factory: () => {} }],
					extensions: [Extension.make("effect", {})],
					noContextFiles: true,
				});
				const { extensions, errors } = yield* loader.getExtensions();
				return { paths: extensions.map((extension) => extension.path), errors };
			}),
		);
		expect(paths).toEqual({ paths: ["<inline:plain>", "<inline:effect>"], errors: [] });
	});

	it("reads the project's context files and the system prompt it was given", async () => {
		const seen = await runTest(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				writeFileSync(join(dir, "AGENTS.md"), "Be brief.\n");
				const loader = yield* ResourceLoader.make({
					cwd: dir,
					agentDir: join(dir, "agent"),
					systemPrompt: "You help.",
				});
				return {
					files: (yield* loader.getAgentsFiles()).agentsFiles.map((file) => file.content),
					prompt: yield* loader.getSystemPrompt(),
				};
			}),
		);
		expect(seen).toEqual({ files: ["Be brief.\n"], prompt: "You help." });
	});
});

describe("loadProjectContextFiles", () => {
	it("reads AGENTS.md of the working directory", async () => {
		const files = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				writeFileSync(join(dir, "AGENTS.md"), "Rules.\n");
				return yield* loadProjectContextFiles({ cwd: dir, agentDir: join(dir, "agent") });
			}),
		);
		expect(files.map((file) => file.content)).toEqual(["Rules.\n"]);
	});
});

describe("discoverAndLoadExtensions", () => {
	it("loads the extension files of the given paths", async () => {
		const loaded = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				mkdirSync(join(dir, "ext"));
				writeFileSync(join(dir, "ext", "commands.js"), EXTENSION_FILE);
				return yield* discoverAndLoadExtensions([join(dir, "ext", "commands.js")], dir, join(dir, "agent"));
			}),
		);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])).toEqual(["from-file"]);
	});
});
