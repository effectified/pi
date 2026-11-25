// Bun only: a Rivet engine of this process's own, for tests and local runs. On Bun an assignment to `process.env`
// changes Bun's own view and not the process's environment, which rivetkit's native core reads: this entry sets the
// variable with the C library's `setenv`.

import { Effect, type Scope } from "effect";
import { bunFfi } from "./bun/ffi.ts";
import { EngineUnavailable } from "./errors.ts";
import * as Local from "./node/local-engine.ts";
import * as Platform from "./node/platform.ts";

export { available, type LocalEngine, type ServeOptions } from "./node/local-engine.ts";
export { running, stop } from "./node/platform.ts";

/**
 * Starts an engine and a registry of `actors` for the scope: on a free port and a new temporary directory, or on the
 * `port` and in the `directory` given, which is kept. See `Local.serve`. It fails with `EngineUnavailable` on a
 * platform whose C library this entry does not know.
 */
export function serve(options: Local.ServeOptions): Effect.Effect<Local.LocalEngine, EngineUnavailable, Scope.Scope> {
	return Effect.provide(Local.serve(bunEnvironment, options), Platform.layer);
}

/** The C library by platform: the one every process is linked to. */
const C_LIBRARY: Readonly<Record<string, string>> = { darwin: "libSystem.B.dylib", linux: "libc.so.6" };

const bunEnvironment: Local.Environment = {
	set: (name, value) =>
		Effect.try({
			try: () => {
				// On a runtime without `bun:ffi` the assignment below is the whole job: Node's reaches the environment.
				const library = bunFfi()?.dlopen(C_LIBRARY[process.platform] ?? "", {
					setenv: { args: ["ptr", "ptr", "i32"], returns: "i32" },
				});
				library?.symbols.setenv?.(cString(name), cString(value), 1);
				library?.close();
				// Bun's own view too, for what reads the variable in JavaScript.
				process.env[name] = value;
			},
			catch: (cause) =>
				new EngineUnavailable({
					code: "environment",
					message: `The process environment could not be set on ${process.platform}: ${String(cause)}`,
					retryable: false,
				}),
		}),
};

/** A NUL-terminated copy of `text`, as C reads a string. */
function cString(text: string): Uint8Array {
	return new TextEncoder().encode(`${text}\0`);
}
