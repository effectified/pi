import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

describe("ProjectTrustStore", () => {
	it("stores a decision in the agent directory and reads it back", async () => {
		const decision = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const store = yield* ProjectTrustStore.make(dir);
				const before = yield* store.get(join(dir, "project"));
				yield* store.set(join(dir, "project"), true);
				const again = yield* ProjectTrustStore.make(dir);
				return { before, after: yield* again.get(join(dir, "project")) };
			}),
		);
		expect(decision).toEqual({ before: null, after: true });
	});
});

describe("hasTrustRequiringProjectResources", () => {
	it("is true once the project holds resources that need trust, such as its own extensions", async () => {
		const seen = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				const before = yield* hasTrustRequiringProjectResources(dir);
				mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
				writeFileSync(join(dir, ".pi", "extensions", "x.ts"), "export default () => {};\n");
				return { before, after: yield* hasTrustRequiringProjectResources(dir) };
			}),
		);
		expect(seen).toEqual({ before: false, after: true });
	});
});
