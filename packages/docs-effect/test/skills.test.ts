// The skills keep their contract, and the checker of the contract can fail: each rule is shown a skill that breaks it.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HERE, read } from "../src/node/facts.ts";
import { DISK, LIMITS, parse, problems, readSkills, type Tree } from "../src/node/skills.ts";

const facts = read();
const skills = readSkills();

/** A skill named `fixture` whose `SKILL.md` holds `text`, checked against the repository with that file in front. */
const broken = (text: string): string[] => {
	const skill = parse("fixture", text);
	const tree: Tree = {
		read: (path) => (path === skill.path ? text : DISK.read(path)),
		exists: (path) => path === skill.path || DISK.exists(path),
	};
	return problems(skill, facts, tree);
};

const HEAD = "---\nname: fixture\ndescription: Shows the checker one broken rule.\n---\n";

/** Two lines that stand in the composition's README example, one after the other. */
const EXCERPT = ["const outcome = Threads.Threads.use((threads) =>", "\tthreads.work({"];

describe("the skills of this package", () => {
	it("are the seven the README names", () => {
		const readme = readFileSync(join(HERE, "README.md"), "utf8");
		const named = [...readme.matchAll(/^\| `(pi-effect[a-z-]*)` \|/gm)].map(([, name]) => name);
		expect(skills.map((skill) => skill.name)).toEqual(named.sort());
		expect(skills.length).toBe(7);
	});

	it("each keep the contract", () => {
		expect(skills.flatMap((skill) => problems(skill, facts))).toEqual([]);
	});

	it("each say when to use them, in a description an agent's harness can take", () => {
		for (const skill of skills) {
			expect(skill.description.length, skill.name).toBeGreaterThan(80);
			expect(skill.description.length, skill.name).toBeLessThanOrEqual(LIMITS.description);
			expect(skill.description, skill.name).toMatch(/\bUse\b[^.]*\b(?:when|before|for|to)\b/);
		}
	});
});

describe("the checker of the contract", () => {
	it("passes a skill that links a README's heading and quotes its example, whatever the indentation", () => {
		const text = `${HEAD}# Fixture

See [the composition](../../../thread-effect/README.md#the-composition) of \`@gunta/pi-thread-effect/rivet\`.

\`\`\`ts
        ${EXCERPT[0]}
        ${EXCERPT[1]}
\`\`\`
`;
		expect(broken(text)).toEqual([]);
	});

	it("names a frontmatter that is not name then description, and a name that is not the directory's", () => {
		expect(broken("---\nname: other\ndescription: Something.\nlicense: MIT\n---\nBody.\n")).toEqual([
			expect.stringContaining("the frontmatter is name, description, license"),
			expect.stringContaining('name "other" is not its directory\'s'),
		]);
		expect(broken("# No frontmatter\n")).toEqual(
			expect.arrayContaining([expect.stringContaining("the frontmatter is missing")]),
		);
	});

	it("names a description a YAML reader would not take as text, and one that is too long", () => {
		expect(broken("---\nname: fixture\ndescription: Covers one thing: and another.\n---\nBody.\n")).toEqual([
			expect.stringContaining("must be in quotes"),
		]);
		expect(broken('---\nname: fixture\ndescription: "Covers one thing: and another."\n---\nBody.\n')).toEqual([]);
		expect(broken(`---\nname: fixture\ndescription: ${"long ".repeat(250)}\n---\nBody.\n`)).toEqual([
			expect.stringContaining(`over ${LIMITS.description}`),
		]);
	});

	it("names a body that is empty, and one too long to be one read", () => {
		expect(broken(HEAD)).toEqual([expect.stringContaining("no body")]);
		expect(broken(`${HEAD}${"A line.\n".repeat(LIMITS.bodyLines + 1)}`)).toEqual([
			expect.stringContaining(`over ${LIMITS.bodyLines}`),
		]);
	});

	it("names a link that leaves the READMEs and the skills, one to no file, and one to no heading", () => {
		expect(broken(`${HEAD}[The source](../../../thread-effect/src/index.ts)\n`)).toEqual([
			expect.stringContaining("leads to neither a package's README nor a file of the skills"),
		]);
		expect(broken(`${HEAD}[Another skill](../no-such-skill/SKILL.md)\n`)).toEqual([
			expect.stringContaining("leads to no file"),
		]);
		expect(broken(`${HEAD}[A heading](../../../thread-effect/README.md#no-such-heading)\n`)).toEqual([
			expect.stringContaining("names a heading packages/thread-effect/README.md does not have"),
		]);
		// A link in a code block is no link of the skill.
		expect(broken(`${HEAD}Text.\n\n\`\`\`md\n[x](../../../thread-effect/src/index.ts)\n\`\`\`\n`)).toEqual([]);
	});

	it("names a package and an entry point the library does not have", () => {
		expect(broken(`${HEAD}Use \`@gunta/pi-workflow-effect\` and \`@gunta/pi-thread-effect/actors\`.\n`)).toEqual([
			expect.stringContaining("@gunta/pi-workflow-effect is no package"),
			expect.stringContaining("@gunta/pi-thread-effect/actors is no package"),
		]);
	});

	it("names code that no README has, also when one line of an example was changed", () => {
		expect(broken(`${HEAD}\`\`\`ts\nconst made = yield* Threads.make();\n\`\`\`\n`)).toEqual([
			expect.stringContaining("is no excerpt of a README's code block"),
		]);
		expect(broken(`${HEAD}\`\`\`ts\n${EXCERPT[0]}\n\tthreads.start({\n\`\`\`\n`)).toEqual([
			expect.stringContaining("is no excerpt of a README's code block"),
		]);
		// Other languages are commands and data, which no README test runs.
		expect(broken(`${HEAD}\`\`\`sh\nnode effect/scripts/gate.ts\n\`\`\`\n`)).toEqual([]);
	});

	it("names a path and a script of this repository that do not exist", () => {
		expect(broken(`${HEAD}Read \`effect/NO-SUCH.md\`, then run \`node effect/scripts/no-such.ts\`.\n`)).toEqual([
			expect.stringContaining("`effect/NO-SUCH.md` does not exist"),
			expect.stringContaining("the script effect/scripts/no-such.ts does not exist"),
		]);
	});
});

describe("link-skills.mjs", () => {
	const project = mkdtempSync(join(tmpdir(), "pi-docs-effect-"));
	const script = join(HERE, "bin/link-skills.mjs");
	const link = () => spawnSync(process.execPath, [script, project], { encoding: "utf8" });

	afterAll(() => rmSync(project, { recursive: true, force: true }));

	// A product gets the skills for building on the packages, not the two for work inside this repository.
	const linked = skills.filter((skill) => !["pi-effect-contributing", "pi-effect-upstream-sync"].includes(skill.name));

	it("links a product's skills into the two directories an agent's harness reads, and makes no link twice", () => {
		const first = link();
		expect(first.status).toBe(0);
		expect(linked.length).toBe(skills.length - 2);
		expect(first.stdout).toContain(`${linked.length} skills`);
		expect(first.stdout).toContain(`${linked.length * 2} links made`);
		for (const home of [".claude/skills", ".agents/skills"]) {
			expect(existsSync(join(project, home, "pi-effect-contributing"))).toBe(false);
			for (const skill of linked) {
				const made = join(project, home, skill.name);
				expect(lstatSync(made).isSymbolicLink()).toBe(true);
				expect(existsSync(join(made, "SKILL.md"))).toBe(true);
				expect(readlinkSync(made).startsWith("/")).toBe(false);
			}
		}
		expect(link().stdout).toContain("0 links made");
	});

	it("repairs a link that points elsewhere, and leaves a directory that is the project's own", () => {
		const moved = join(project, ".claude/skills", linked[0]?.name ?? "");
		rmSync(moved);
		symlinkSync("../nowhere", moved, "dir");
		const own = join(project, ".agents/skills", linked[1]?.name ?? "");
		rmSync(own);
		mkdirSync(own);
		const run = link();
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("exists and is no link");
		expect(existsSync(join(moved, "SKILL.md"))).toBe(true);
		expect(lstatSync(own).isDirectory()).toBe(true);
	});

	it("links all of them into the pi-effect repository, and only into the directories it is given", () => {
		const repository = mkdtempSync(join(tmpdir(), "pi-docs-effect-"));
		try {
			mkdirSync(join(repository, "effect/scripts"), { recursive: true });
			writeFileSync(join(repository, "effect/scripts/gate.ts"), "");
			const run = spawnSync(process.execPath, [script, repository, ".claude/skills"], { encoding: "utf8" });
			expect(run.stdout).toContain(`${skills.length} skills`);
			expect(run.stdout).toContain(`${skills.length} links made`);
			expect(existsSync(join(repository, ".claude/skills/pi-effect-contributing/SKILL.md"))).toBe(true);
			expect(existsSync(join(repository, ".agents"))).toBe(false);
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});
});
