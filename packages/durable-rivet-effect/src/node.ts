// Node.js only: a Rivet engine of this process's own, for tests and local runs. On Bun, use the `bun` entry.

import { Effect, type Scope } from "effect";
import { EngineUnavailable } from "./errors.ts";
import * as Local from "./node/local-engine.ts";

export { running, stop } from "./node/engine-process.ts";
export { available, type LocalEngine, type ServeOptions } from "./node/local-engine.ts";

/**
 * Starts an engine and a registry of `actors` for the scope: on a free port and a new temporary directory, or on the
 * `port` and in the `directory` given, which is kept. See `Local.serve`. It fails with `EngineUnavailable` on Bun,
 * where an assignment to `process.env` does not reach rivetkit's native core, and the engine would keep its data in
 * the directory every project shares.
 */
export function serve(options: Local.ServeOptions): Effect.Effect<Local.LocalEngine, EngineUnavailable, Scope.Scope> {
	// Feature detection: only Bun has this global.
	if ("Bun" in globalThis) {
		return Effect.fail(
			new EngineUnavailable({
				code: "environment",
				message: "On Bun, start the local engine with @gunta/pi-durable-rivet-effect/bun",
				retryable: false,
			}),
		);
	}
	return Local.serve(nodeEnvironment, options);
}

// On Node.js `process.env` is the process's environment itself.
const nodeEnvironment: Local.Environment = {
	set: (name, value) =>
		Effect.sync(() => {
			process.env[name] = value;
		}),
};
