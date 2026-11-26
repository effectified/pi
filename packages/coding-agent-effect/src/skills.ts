// pi-coding-agent's skills in Effect: reading the skills of directories and files (their `SKILL.md` frontmatter and
// diagnostics) as Effects. Formatting them for a prompt is Pi's pure `formatSkillsForPrompt`.

import {
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills as piLoadSkills,
	loadSkillsFromDir as piLoadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CodingAgentFailure, fromPi } from "./errors.ts";

/** The skills of the agent directory, the project and `options`' paths, as Pi's resource loader finds them. */
export function loadSkills(
	options: Parameters<typeof piLoadSkills>[0],
): Effect.Effect<LoadSkillsResult, CodingAgentFailure> {
	return Effect.try({ try: () => piLoadSkills(options), catch: fromPi });
}

/** The skills of one directory. */
export function loadSkillsFromDir(
	options: LoadSkillsFromDirOptions,
): Effect.Effect<LoadSkillsResult, CodingAgentFailure> {
	return Effect.try({ try: () => piLoadSkillsFromDir(options), catch: fromPi });
}
