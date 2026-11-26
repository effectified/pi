// `@effectified/pi-durable/env/node`: Pi's environment on the local machine, through Node's file system and child
// processes (Bun runs it too), as a scoped resource.

import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import { Effect, type Scope } from "effect";

export type { NodeWatchOptions } from "@earendil-works/pi-durable/env/node";

/** Options of `make`: Pi's options of `NodeExecutionEnv`. */
export type Options = ConstructorParameters<typeof NodeExecutionEnv>[0];

/**
 * Pi's local environment rooted at `cwd`, cleaned up when the scope closes: the commands it still runs are killed.
 * Give it to a harness's `env`, or to `@effectified/pi-env`'s `Env.fromPi` for its operations as Effects.
 */
export function make(options: Options): Effect.Effect<NodeExecutionEnv, never, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.sync(() => new NodeExecutionEnv(options)),
		(env) => Effect.promise(() => env.cleanup(BACKGROUND_CONTEXT)),
	);
}
