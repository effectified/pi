// What the tests share: a temporary directory per test, Pi's Node environment in it, and the pi-env daemon of this
// checkout when one was built.

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect, type Scope } from "effect";

/** A new temporary directory (its real path), removed when the scope closes. */
export const tempDir: Effect.Effect<string, never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "pi-env-effect-")))),
	(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);

/** Pi Durable's Node environment, working in `cwd`. */
export function nodeEnv(cwd: string): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd });
}

/**
 * The daemon the daemon tests run: `PI_ENV_DAEMON` (as upstream's tests take it), else the one `npm run build:daemon`
 * built in `packages/env`. Undefined when neither exists: those tests are skipped then, since building it needs Cargo.
 */
export const daemon: string | undefined = (() => {
	const path =
		process.env.PI_ENV_DAEMON ??
		resolve(import.meta.dirname, `../../env/daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);
	return existsSync(path) ? path : undefined;
})();

/** Why the daemon tests are skipped, when they are. */
export const NO_DAEMON = "no pi-env daemon: run `npm run build:daemon` in packages/env, or set PI_ENV_DAEMON";
