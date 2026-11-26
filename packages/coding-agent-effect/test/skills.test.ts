import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir } from "../src/index.ts";
import { tempDir } from "./scripted.ts";

/** Writes the skill `name` under `dir`. */
function writeSkill(dir: string, name: string): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nSteps.\n`);
}

describe("loadSkillsFromDir", () => {
	it("reads the skills of a directory, which Pi's pure formatter lists for a prompt", async () => {
		const loaded = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				writeSkill(dir, "deploy");
				return yield* loadSkillsFromDir({ dir, source: "test" });
			}),
		);
		expect(loaded.skills.map((skill) => skill.name)).toEqual(["deploy"]);
		expect(formatSkillsForPrompt(loaded.skills)).toContain("deploy");
	});
});

describe("loadSkills", () => {
	it("reads the skills of the given paths, without the defaults when told so", async () => {
		const names = await runLive(
			Effect.gen(function* () {
				const dir = yield* tempDir;
				writeSkill(join(dir, "skills"), "review");
				const loaded = yield* loadSkills({
					cwd: dir,
					agentDir: dir,
					skillPaths: [join(dir, "skills")],
					includeDefaults: false,
				});
				return loaded.skills.map((skill) => skill.name);
			}),
		);
		expect(names).toEqual(["review"]);
	});
});
