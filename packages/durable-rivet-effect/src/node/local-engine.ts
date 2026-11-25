// A Rivet engine of this process's own, on a free set of ports and a temporary directory, for tests and local runs:
// what the Node.js and the Bun entries share.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Schedule, Scope } from "effect";
import { EngineUnavailable } from "../errors.ts";
import * as Host from "../host.ts";
import * as EngineProcess from "./engine-process.ts";
import * as ExitGuard from "./exit-guard.ts";
import * as Ports from "./ports.ts";

/** A local engine that `serve` started. */
export interface LocalEngine {
	/** Where its clients connect: `Client.layer({ endpoint })`. */
	readonly endpoint: string;
}

/** Options of `serve`: those of `Host.serve`, without the ones that say which engine. */
export type ServeOptions = Omit<Host.ServeOptions, "endpoint" | "startEngine" | "enginePort" | "engineHost">;

/**
 * How a variable gets into the environment rivetkit's native core reads, which is the process's own (`getenv`), not
 * the runtime's view of it: the two are one on Node.js and two on Bun.
 */
export interface Environment {
	readonly set: (name: string, value: string) => Effect.Effect<void, EngineUnavailable>;
	readonly unset: (name: string) => Effect.Effect<void>;
}

/**
 * Whether the engine binary for this platform is installed: rivetkit's `@rivetkit/engine-cli` finds it in its
 * platform package (`@rivetkit/engine-cli-<platform>-<arch>`), or at `RIVET_ENGINE_BINARY_PATH`.
 */
export const available: Effect.Effect<boolean> = Effect.sync(() => {
	try {
		// rivetkit's own resolution: the engine package is its dependency, so it is resolved from where rivetkit is.
		const fromRivetkit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
		const cli: { readonly getEnginePath: () => string } = fromRivetkit("@rivetkit/engine-cli");
		return existsSync(cli.getEnginePath());
	} catch {
		return false;
	}
});

/**
 * Starts an engine and a registry of `actors` for the scope: the engine listens on a free set of ports of the
 * loopback interface (`Ports.free`), so it never meets another project's engine on Rivet's default port, and keeps
 * its data in a new temporary directory. Closing the scope stops the registry and the engine and removes the
 * directory.
 *
 * A start that finds one of its ports taken after all, or whose engine process ends before it is ready (something
 * on the machine stopped it), is made again on another set of ports, `PORT_ATTEMPTS` times in all.
 * A start that fails or is interrupted leaves nothing: its registry is shut down, its engine process is stopped,
 * its directory is removed, and the exit of the process rivetkit makes for it is held back (`ExitGuard`).
 *
 * The directory reaches the engine through the environment variable `RIVETKIT_STORAGE_PATH`, set for the scope and
 * removed afterwards: one local engine per process at a time. Without it rivetkit keeps the data of every project
 * in one directory under the user's home. Rivet's own services are not started.
 */
export function serve(
	environment: Environment,
	options: ServeOptions,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return serveOn(Ports.free, environment, options);
}

/** `serve` with the ports to try given: each run of `ports` gives the port of the next start. */
export function serveOn(
	ports: Effect.Effect<number, EngineUnavailable>,
	environment: Environment,
	options: ServeOptions,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return Effect.retry(
		Effect.flatMap(ports, (port) => start(environment, options, port)),
		{ times: PORT_ATTEMPTS - 1, while: isWorthAnotherStart },
	);
}

/** How many starts `serve` makes before one that found its ports taken, or lost its engine, fails for good. */
export const PORT_ATTEMPTS = 3;

/**
 * One start, on `port` and the ports that go with it (`Ports.OFFSETS`). It fails with the code `port` as soon as the
 * engine reports a port in use, and with the code `lost` as soon as the engine process has ended for another reason,
 * both long before rivetkit gives up on the engine. What it started lives in a scope of
 * its own, closed here when the start fails or is interrupted, and with the caller's scope otherwise.
 */
export function start(
	environment: Environment,
	options: ServeOptions,
	port: number,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const outer = yield* Effect.scope;
			const inner = yield* Scope.make();
			const started = yield* Effect.exit(
				restore(Effect.provideService(engine(environment, options, port), Scope.Scope, inner)),
			);
			if (Exit.isFailure(started)) {
				yield* Scope.close(inner, started);
				return yield* Effect.failCause(started.cause);
			}
			yield* Scope.addFinalizerExit(outer, (exit) => Scope.close(inner, exit));
			return started.value;
		}),
	);
}

/** The engine and the registry of one start, in the scope that owns them. */
function engine(
	environment: Environment,
	options: ServeOptions,
	port: number,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return Effect.gen(function* () {
		const directory = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "pi-durable-rivet-"))),
			(made) => Effect.sync(() => rmSync(made, { recursive: true, force: true })),
		);
		yield* Effect.acquireRelease(environment.set(STORAGE_PATH, directory), () => environment.unset(STORAGE_PATH));
		// Released after the registry and before the directory: an engine rivetkit left is stopped while its files exist.
		yield* Effect.addFinalizer(() => EngineProcess.stop(directory));
		const hold = yield* ExitGuard.hold;
		const registry = Host.serve({
			noWelcome: true,
			startServices: false,
			...options,
			startEngine: true,
			engineHost: LOOPBACK,
			enginePort: port,
		});
		yield* Effect.raceFirst(registry, Effect.raceFirst(portTaken(directory, port), lost(directory))).pipe(
			Effect.onExit((exit) => (Exit.isSuccess(exit) ? hold.ready : hold.failed)),
		);
		return { endpoint: `http://${LOOPBACK}:${port}` };
	});
}

const STORAGE_PATH = "RIVETKIT_STORAGE_PATH";

const LOOPBACK = "127.0.0.1";

/** Whether a start failed for a reason another start may not meet: a port of its set was taken, or its engine ended. */
function isWorthAnotherStart(error: EngineUnavailable): boolean {
	return error.code === "port" || error.code === PORT_OCCUPIED || error.code === LOST;
}

// The code of a start whose engine process ended before the registry was ready.
const LOST = "lost";

// rivetkit's own refusal of a port on which something else already answers.
const PORT_OCCUPIED = "engine.port_occupied";

/**
 * Fails once the engine started on `directory` has reported a port in use, and never succeeds. An engine that cannot
 * bind exits at once and says so, on its standard error for its own port and the next one, in its log on standard
 * output for its metrics port. rivetkit keeps both in files under the directory, and itself goes on asking the dead
 * engine for its health for a minute.
 */
function portTaken(directory: string, port: number): Effect.Effect<never, EngineUnavailable> {
	const logs = join(directory, ".rivetkit", "var", "logs", "rivet-engine");
	const reported = Effect.sync(() => {
		try {
			return readdirSync(logs).some((name) => readFileSync(join(logs, name), "utf8").includes(IN_USE));
		} catch {
			// No log yet: the engine has not been started.
			return false;
		}
	});
	return Effect.andThen(
		Effect.repeat(reported, { until: (found) => found, schedule: Schedule.spaced("100 millis") }),
		Effect.fail(
			new EngineUnavailable({
				code: "port",
				message: `The local engine found a port of its set in use: ${Ports.OFFSETS.map((offset) => port + offset).join(", ")}`,
				retryable: true,
			}),
		),
	);
}

/**
 * Fails once the engine started on `directory` has run and its process is gone, and never succeeds. rivetkit does not
 * watch the engine it started: when something stops it during the start (a signal from another program, such as a
 * `pkill rivet-engine` elsewhere on the machine), rivetkit goes on asking the dead engine for its health for a
 * minute. The failure waits a moment after the process is gone, so that an engine that ended over a port is
 * reported by `portTaken`, which says more.
 */
function lost(directory: string): Effect.Effect<never, EngineUnavailable> {
	const engines = Effect.map(EngineProcess.running(directory), (pids) => pids.length);
	const until = (wanted: (count: number) => boolean) =>
		Effect.repeat(engines, { until: wanted, schedule: Schedule.spaced("250 millis") });
	return until((count) => count > 0).pipe(
		Effect.andThen(until((count) => count === 0)),
		Effect.andThen(Effect.sleep("300 millis")),
		Effect.andThen(
			Effect.fail(
				new EngineUnavailable({
					code: LOST,
					message: "The local engine's process ended before it was ready: something stopped it",
					retryable: true,
				}),
			),
		),
	);
}

// What the engine writes when it cannot bind a port, on macOS (os error 48) and on Linux (os error 98).
const IN_USE = "Address already in use";
