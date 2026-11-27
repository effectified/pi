// Node.js only: a Rivet engine of this process's own, for tests and local runs. On Bun, use the `bun` entry.

import { Effect, type Scope } from "effect";
import { EngineUnavailable } from "./errors.ts";
import * as Local from "./node/local-engine.ts";
import * as Platform from "./node/platform.ts";

export { available, type LocalEngine, type ServeOptions } from "./node/local-engine.ts";
export { running, stop } from "./node/platform.ts";

/**
 * Starts an engine and a registry of `actors` for the scope: on a free port and a new temporary directory, or on the
 * `port` and in the `directory` given, which is kept. See `Local.serve`. It fails with `EngineUnavailable` on Bun,
 * where an assignment to `process.env` does not reach rivetkit's native core, and the engine would keep its data in
 * the directory every project shares.
 */
export const serve: (options: Local.ServeOptions) => Effect.Effect<Local.LocalEngine, EngineUnavailable, Scope.Scope> =
	Effect.fn("LocalEngine.serve")(function* (options: Local.ServeOptions) {
		// Feature detection: only Bun has this global.
		if ("Bun" in globalThis) {
			return yield* EngineUnavailable.make({
				code: "environment",
				message: "On Bun, start the local engine with @effectified/pi-durable-rivet/bun",
				retryable: false,
			});
		}
		return yield* Platform.provide(Local.serve(nodeEnvironment, options));
	});

// On Node.js `process.env` is the process's environment itself.
const nodeEnvironment: Local.Environment = {
	set: (name, value) =>
		Effect.sync(() => {
			// @effect-diagnostics-next-line processEnvInEffect:off A write, not a read: rivetkit's native core reads its storage path from the process environment, which `Config` cannot set.
			process.env[name] = value;
		}),
};
