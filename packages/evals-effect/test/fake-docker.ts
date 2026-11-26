// A `docker` command for the tests of the container runner, first on `PATH`: Pi's runner runs the real Pi code and
// this script answers for Docker. A build succeeds, an inspection prints an id, and a run copies the fixture named
// by `FAKE_DOCKER_DISCOVERY` or `FAKE_DOCKER_REPORT` into the directory mounted at `/artifacts`.

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, type Scope } from "effect";
import { processEnvironment, temporaryDirectory } from "./fixtures.ts";

const SCRIPT = `#!/bin/sh
case "$1" in
	build) exit 0 ;;
	image) echo "sha256:$5"; exit 0 ;;
	run)
		for arg in "$@"; do
			case "$arg" in
				type=bind,source=*,target=/artifacts) out=\${arg#type=bind,source=}; out=\${out%,target=/artifacts} ;;
			esac
		done
		case " $* " in
			*" --discover "*) cp "$FAKE_DOCKER_DISCOVERY" "$out/discovered-tests.json" ;;
			*) if [ -n "$FAKE_DOCKER_REPORT" ]; then cp "$FAKE_DOCKER_REPORT" "$out/vitest.json"; fi ;;
		esac
		exit 0 ;;
esac
exit 1
`;

/** For the scope: the fake `docker` first on `PATH`, answering runs with the given fixture files. */
export function fakeDocker(fixtures: {
	readonly discovery?: string;
	readonly report?: string;
}): Effect.Effect<void, never, Scope.Scope> {
	return Effect.gen(function* () {
		const directory = yield* temporaryDirectory;
		const docker = join(directory, "docker");
		yield* Effect.promise(() => writeFile(docker, SCRIPT).then(() => chmod(docker, 0o755)));
		yield* processEnvironment({
			PATH: `${directory}:${process.env.PATH ?? ""}`,
			FAKE_DOCKER_DISCOVERY: fixtures.discovery,
			FAKE_DOCKER_REPORT: fixtures.report,
		});
	});
}

/** For the scope: no `docker` anywhere on `PATH`. */
export const noDocker: Effect.Effect<void, never, Scope.Scope> = Effect.flatMap(temporaryDirectory, (directory) =>
	processEnvironment({ PATH: directory }),
);
