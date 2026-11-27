// The container runner of a documentation comparison: the two variant images, the discovery of their cases, and one
// isolated container per task, whose observations come as a Stream.

import {
	type BuiltImages,
	type createDockerContext,
	buildImages as piBuildImages,
	discoverCases as piDiscoverCases,
	requireEvalAuthFile as piRequireEvalAuthFile,
	runTask as piRunTask,
} from "@earendil-works/pi-evals/src/docker.ts";
import type { DocumentationVariant, EvalTask } from "@earendil-works/pi-evals/src/plan.ts";
import { type EvalObservation, erroredObservation } from "@earendil-works/pi-evals/src/report.ts";
import { Effect, Stream } from "effect";
import { type ArtifactFailed, DockerFailed, InvalidSetting, messageOf } from "./errors.ts";
import { readTaskObservation } from "./report.ts";

/** What the container runs of one comparison share: the images, the artifact directory, the model and the runs. */
export type DockerContext = ReturnType<typeof createDockerContext>;

// Pi runs `docker` with `spawnSync`: every Effect here holds its fiber's thread until `docker` exits, and interrupting
// the fiber takes effect after that.

/**
 * Builds the `without_docs` and `with_docs` images from the repository, named after its path, and reads their ids.
 * Fails with `DockerFailed` when a build or an inspection fails.
 */
export const buildImages: Effect.Effect<BuiltImages, DockerFailed> = Effect.try({
	try: () => piBuildImages(),
	catch: dockerFailed,
}).pipe(Effect.withSpan("Docker.buildImages"));

/**
 * The path of the agent directory's `auth.json` (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), which the containers
 * mount read-only. Fails with `InvalidSetting` when it does not exist, does not parse, or has no credential for
 * `provider`.
 */
export const requireAuthFile = Effect.fn("Docker.requireAuthFile")((provider: string) =>
	Effect.try({
		try: () => piRequireEvalAuthFile(provider),
		catch: (cause) => InvalidSetting.make({ message: messageOf(cause) }),
	}),
);

/**
 * Lists the cases of `files` that `vitestArgs` select in the image of `variant`, and resolves with the path of the
 * `discovered-tests.json` it wrote (read it with `Plan.readDiscoveredCases`). Fails with `DockerFailed` when the
 * discovery fails.
 */
export const discoverCases = Effect.fn("Docker.discoverCases")(
	(context: DockerContext, variant: DocumentationVariant, files: readonly string[], vitestArgs: readonly string[]) =>
		Effect.try({ try: () => piDiscoverCases(context, variant, files, vitestArgs), catch: dockerFailed }),
);

/**
 * Runs one task in a new container of its variant's image and resolves with the path of its Vitest JSON report, or
 * `undefined` when the run wrote none. A run whose eval failed is not a failure: its report says so. Fails with
 * `DockerFailed` when `docker` cannot start.
 */
export const runTask = Effect.fn("Docker.runTask")((context: DockerContext, task: EvalTask) =>
	Effect.try({ try: () => piRunTask(context, task), catch: dockerFailed }),
);

/**
 * The observation of each task, in order, as each container run ends: what Pi's comparison runner does with its
 * plan. A run without a report is an `errored` observation. Keeping the observations and the report is the caller's
 * (`Report.EvalObservation`, `Report.summarize`).
 */
export function observe(
	context: DockerContext,
	tasks: readonly EvalTask[],
): Stream.Stream<EvalObservation, DockerFailed | ArtifactFailed> {
	return Stream.mapEffect(
		Stream.fromIterable(tasks),
		(task) =>
			Effect.flatMap(runTask(context, task), (reportPath) =>
				reportPath === undefined
					? Effect.succeed(erroredObservation(task))
					: readTaskObservation(task, reportPath, context.artifactDirectory),
			),
		// One container at a time, as Pi's runner: `docker` runs synchronously, and the runs share the machine.
		{ concurrency: 1 },
	);
}

function dockerFailed(cause: unknown): DockerFailed {
	return DockerFailed.make({ message: messageOf(cause), cause });
}
