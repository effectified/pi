import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createDockerContext, Docker, DockerFailed, InvalidSetting, Plan } from "../src/index.ts";
import { fakeDocker, noDocker } from "./fake-docker.ts";
import { processEnvironment, temporaryDirectory } from "./fixtures.ts";
import { TASK, vitestReport } from "./vitest-report.ts";

const IMAGES = {
	without_docs: { name: "evals-without-docs:local", id: "sha256:without" },
	with_docs: { name: "evals-with-docs:local", id: "sha256:with" },
};

/** A comparison's context whose artifacts go to a new directory. */
const context = Effect.map(temporaryDirectory, (directory) =>
	createDockerContext(IMAGES, directory, join(directory, "auth.json"), "fixture", "model", 1),
);

/** `contents` in a new file, and its path. */
function fixture(contents: string) {
	return Effect.gen(function* () {
		const path = join(yield* temporaryDirectory, "fixture.json");
		yield* Effect.promise(() => writeFile(path, contents));
		return path;
	});
}

describe("requireAuthFile", () => {
	it("is the agent directory's auth.json when it has a credential of the provider, else InvalidSetting", () =>
		runLive(
			Effect.gen(function* () {
				const agentDir = yield* temporaryDirectory;
				yield* processEnvironment({ PI_CODING_AGENT_DIR: agentDir });
				const missing = yield* Effect.flip(Docker.requireAuthFile("openai"));
				expect(missing).toBeInstanceOf(InvalidSetting);
				expect(missing.message).toContain("does not exist");
				yield* Effect.promise(() => writeFile(join(agentDir, "auth.json"), '{"openai":{"type":"api_key"}}'));
				expect(yield* Docker.requireAuthFile("openai")).toBe(join(agentDir, "auth.json"));
				const other = yield* Effect.flip(Docker.requireAuthFile("anthropic"));
				expect(other.message).toBe("Eval authentication file has no credential for provider anthropic.");
			}),
		));
});

describe("buildImages and discoverCases", () => {
	it("build both images, read their ids, and discover the cases a variant's image lists", () =>
		runLive(
			Effect.gen(function* () {
				const discovery = yield* fixture(JSON.stringify([{ name: "Set > case", file: "evals/a.docs.eval.ts" }]));
				yield* fakeDocker({ discovery });
				const images = yield* Docker.buildImages;
				expect(images.with_docs.name).toMatch(/^pi-evals-[0-9a-f]{12}-with-docs:local$/);
				expect(images.with_docs.id).toBe(`sha256:${images.with_docs.name}`);
				const path = yield* Docker.discoverCases(yield* context, "with_docs", ["evals/a.docs.eval.ts"], []);
				const discovered = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")));
				expect(yield* Plan.parseDiscoveredCases(discovered)).toEqual([
					{ file: "evals/a.docs.eval.ts", fullName: "Set > case", evalSet: "Set", caseId: "case" },
				]);
			}),
		));

	it("fail with DockerFailed when docker cannot run", () =>
		runLive(
			Effect.gen(function* () {
				yield* noDocker;
				expect(yield* Effect.flip(Docker.buildImages)).toBeInstanceOf(DockerFailed);
				const failure = yield* Effect.flip(Docker.discoverCases(yield* context, "with_docs", [], []));
				expect(failure._tag).toBe("DockerFailed");
			}),
		));
});

describe("observe", () => {
	it("runs each task in a container and streams its observation, read from the report the run wrote", () =>
		runLive(
			Effect.gen(function* () {
				yield* fakeDocker({ report: yield* fixture(vitestReport(1)) });
				const observations = yield* Stream.runCollect(Docker.observe(yield* context, [TASK]));
				expect(observations.map(({ outcome }) => outcome)).toEqual(["scored"]);
			}),
		));

	it("streams an errored observation for a run that wrote no report", () =>
		runLive(
			Effect.gen(function* () {
				yield* fakeDocker({});
				const observations = yield* Stream.runCollect(Docker.observe(yield* context, [TASK, TASK]));
				expect(observations.map(({ outcome }) => outcome)).toEqual(["errored", "errored"]);
			}),
		));

	it("fails with DockerFailed when docker cannot run", () =>
		runLive(
			Effect.gen(function* () {
				yield* noDocker;
				const failure = yield* Effect.flip(Stream.runCollect(Docker.observe(yield* context, [TASK])));
				expect(failure).toBeInstanceOf(DockerFailed);
				expect(yield* Effect.flip(Docker.runTask(yield* context, TASK))).toBeInstanceOf(DockerFailed);
			}),
		));
});
