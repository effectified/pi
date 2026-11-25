// A Rivet engine of this process's own, on ports and in a directory that are no other project's: a temporary
// directory and a free set of ports for tests, a kept directory and a chosen port for a product that runs locally.
// What the Node.js and the Bun entries share.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Exit, Schedule, Schema, Scope, Semaphore } from "effect";
import { EngineUnavailable } from "../errors.ts";
import * as Host from "../host.ts";
import * as EngineProcess from "./engine-process.ts";
import * as ExitGuard from "./exit-guard.ts";
import * as Keeper from "./keeper.ts";
import * as Ports from "./ports.ts";

/** A local engine that `serve` started. */
export interface LocalEngine {
	/** Where its clients connect: `Client.layer({ endpoint })`. */
	readonly endpoint: string;
	/** Where it keeps its data: the directory `serve` was given, or the temporary one it made. */
	readonly directory: string;
}

/** Options of `serve`: those of `Host.serve` without the ones that say which engine, and where this engine lives. */
export interface ServeOptions
	extends Omit<Host.ServeOptions, "endpoint" | "startEngine" | "enginePort" | "engineHost"> {
	/**
	 * The engine's own directory, which holds its actors' state and is kept: `serve` makes `.rivetkit` in it, stops an
	 * engine that a process which ended left running on it, and leaves it in place when the scope closes. Never the
	 * user's home, where rivetkit keeps the engine every project shares. Default: a new temporary directory, removed
	 * with the scope.
	 */
	readonly directory?: string;
	/**
	 * The engine's port, with the ports that go with it (`Ports.OFFSETS`). A start that finds one of them in use
	 * fails. Default: a free set, drawn again for each start.
	 */
	readonly port?: number;
}

/**
 * How a variable gets into the environment rivetkit's native core reads, which is the process's own (`getenv`), not
 * the runtime's view of it: the two are one on Node.js and two on Bun.
 */
export interface Environment {
	readonly set: (name: string, value: string) => Effect.Effect<void, EngineUnavailable>;
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
 * directory. With `directory` the engine's data is kept there, and with `port` the engine has that port: a product
 * that runs locally starts the same engine again at its next run.
 *
 * A start that finds one of its ports taken after all, or whose engine process ends before it is ready (something
 * on the machine stopped it), is made again, on another set of ports unless `port` names one, `PORT_ATTEMPTS` times
 * in all. A start that fails or is interrupted leaves nothing but a directory that was given: its registry is shut
 * down, its engine process is stopped, and the exit of the process rivetkit makes for it is held back (`ExitGuard`).
 * A process that ends without closing the scope, a killed one too, leaves no engine either (`Keeper`).
 *
 * A process may run several local engines. The directory reaches an engine through the environment variable
 * `RIVETKIT_STORAGE_PATH`, which is the process's: one engine starts at a time, and the variable keeps the directory
 * of the last start, since rivetkit reads it at every step of a start, also of one that was given up and still
 * runs. Without it rivetkit keeps the data of every project in one directory under the user's home. Rivet's own
 * services are not started.
 */
export function serve(
	environment: Environment,
	options: ServeOptions,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return serveOn(options.port === undefined ? Ports.free : Ports.only(options.port), environment, options);
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
 * One start, on `port` and the ports that go with it (`Ports.OFFSETS`), after the start before it in this process
 * ended. It fails with the code `port` as soon as the engine reports a port in use, or when another engine answers
 * on the port, and with the code `lost` as soon as the engine process has ended for another reason, all long before
 * rivetkit gives up on the engine. What it started lives in a scope of its own, closed here when the start fails or
 * is interrupted, and with the caller's scope otherwise.
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
				restore(
					Effect.provideService(STARTING.withPermits(1)(engine(environment, options, port)), Scope.Scope, inner),
				),
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

// The environment is the process's, and each start reads its directory from it: one start at a time.
const STARTING = Semaphore.makeUnsafe(1);

/** The engine and the registry of one start, in the scope that owns them. */
function engine(
	environment: Environment,
	options: ServeOptions,
	port: number,
): Effect.Effect<LocalEngine, EngineUnavailable, Scope.Scope> {
	return Effect.gen(function* () {
		const { directory: given, port: _chosen, ...host } = options;
		const directory = yield* given === undefined ? temporary : kept(given);
		yield* environment.set(STORAGE_PATH, directory);
		const watch = yield* Keeper.keep(directory);
		// Released after the registry and before the directory: an engine rivetkit left is stopped while its files exist.
		yield* Effect.addFinalizer(() => EngineProcess.stop(directory));
		const hold = yield* ExitGuard.hold;
		const endpoint = `http://${LOOPBACK}:${port}`;
		const registry = Host.serve({
			noWelcome: true,
			startServices: false,
			...host,
			startEngine: true,
			engineHost: LOOPBACK,
			enginePort: port,
		});
		yield* Effect.raceFirst(registry, Effect.raceFirst(portTaken(directory, port), lost(directory))).pipe(
			Effect.andThen(started(directory, endpoint)),
			Effect.tap(watch.engines),
			Effect.onExit((exit) => (Exit.isSuccess(exit) ? hold.ready : hold.failed)),
		);
		return { endpoint, directory };
	});
}

/** A new directory for one start, removed with its scope. */
const temporary: Effect.Effect<string, never, Scope.Scope> = Effect.acquireRelease(
	Effect.sync(() => mkdtempSync(join(tmpdir(), "pi-durable-rivet-"))),
	(made) => Effect.sync(() => rmSync(made, { recursive: true, force: true })),
);

/**
 * The directory its caller keeps, ready for a start: made if it is not there, and with no engine left running on it.
 * Two engines on one directory would share the state of its actors.
 */
function kept(given: string): Effect.Effect<string, EngineUnavailable> {
	const directory = resolve(given);
	if (directory === resolve(homedir())) {
		return Effect.fail(
			new EngineUnavailable({
				code: "environment",
				message:
					"A local engine's directory must not be the user's home, where rivetkit keeps the engine every project shares",
				retryable: false,
			}),
		);
	}
	return Effect.as(
		Effect.andThen(
			Effect.sync(() => mkdirSync(directory, { recursive: true })),
			EngineProcess.stop(directory),
		),
		directory,
	);
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
	const reported = Effect.map(logged(directory), (texts) => texts.some((text) => IN_USE.test(text)));
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
 * minute.
 *
 * That it ran is known from the process list or from what it wrote: an engine that ended at once may never be seen
 * running, and on Linux one that ended and was not waited for yet has no command line to know it by. That it is gone
 * is two looks a moment apart, so that an engine that ended over a port is reported by `portTaken`, which says more.
 */
function lost(directory: string): Effect.Effect<never, EngineUnavailable> {
	const running = Effect.map(EngineProcess.running(directory), (pids) => pids.length > 0);
	const wrote = Effect.map(logged(directory), (texts) => texts.some((text) => text !== ""));
	return Effect.gen(function* () {
		while (!((yield* running) || (yield* wrote))) yield* Effect.sleep("250 millis");
		while (true) {
			if (yield* running) {
				yield* Effect.sleep("250 millis");
				continue;
			}
			yield* Effect.sleep("300 millis");
			if (!(yield* running)) break;
		}
		return yield* new EngineUnavailable({
			code: LOST,
			message: "The local engine's process ended before it was ready: something stopped it",
			retryable: true,
		});
	});
}

/**
 * The processes of the engine this start made on `directory`, and a failure unless that engine is the one that
 * answers on `endpoint`. rivetkit uses any engine that answers on the port in place of starting its own; the engine
 * it started says in a file of its directory which process it is and where it answers.
 */
function started(directory: string, endpoint: string): Effect.Effect<ReadonlyArray<number>, EngineUnavailable> {
	const another = new EngineUnavailable({
		code: "port",
		message: `The engine that answers on ${endpoint} was not started on ${directory}: another engine has the port`,
		retryable: true,
	});
	return Effect.gen(function* () {
		const stamp = yield* Effect.mapError(
			Effect.flatMap(
				Effect.try(() => readFileSync(join(directory, ".rivetkit", "var", "engine", "runtime.json"), "utf8")),
				Schema.decodeUnknownEffect(Stamp),
			),
			() => another,
		);
		const running = yield* EngineProcess.running(directory);
		if (stamp.endpoint !== endpoint || !running.includes(stamp.pid)) return yield* another;
		return running;
	});
}

/** What rivetkit writes of the engine it started: a file on disk, so it is decoded. */
const Stamp = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number, endpoint: Schema.String }));

/**
 * What the engine started on `directory` has written so far: the text of each file rivetkit keeps its standard
 * output and its standard error in. Empty before the engine was started.
 */
function logged(directory: string): Effect.Effect<ReadonlyArray<string>> {
	const logs = join(directory, ".rivetkit", "var", "logs", "rivet-engine");
	return Effect.sync(() => {
		try {
			return readdirSync(logs).map((name) => readFileSync(join(logs, name), "utf8"));
		} catch {
			// No log yet: the engine has not been started.
			return [];
		}
	});
}

// What the engine writes when it cannot bind a port: the C library's words for the error, "Address already in use"
// on macOS (os error 48) and "Address in use" in the engine's Linux binary (os error 98), or Rust's name of its kind.
const IN_USE = /Address (?:already )?in use|AddrInUse/;
