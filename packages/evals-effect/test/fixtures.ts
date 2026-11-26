// What the tests share: values in the process environment and a temporary directory, each for a scope.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Scope } from "effect";

/** `values` in the process environment for the scope (`undefined` removes one); closing it restores the old ones. */
export function processEnvironment(
	values: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, never, Scope.Scope> {
	return Effect.asVoid(
		Effect.acquireRelease(
			Effect.sync(() => {
				const previous = Object.keys(values).map((name) => [name, process.env[name]] as const);
				for (const [name, value] of Object.entries(values)) set(name, value);
				return previous;
			}),
			(previous) =>
				Effect.sync(() => {
					for (const [name, value] of previous) set(name, value);
				}),
		),
	);
}

function set(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A new empty directory for the scope, removed with what is in it when the scope closes. */
export const temporaryDirectory: Effect.Effect<string, never, Scope.Scope> = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), "evals-effect-"))),
	(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);
