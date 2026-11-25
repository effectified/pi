// The process that hosts actors: a rivetkit registry of this package's actors, started and stopped with a scope.

import { Effect, Exit, Predicate, type Scope } from "effect";
import { type RegistryActors, type RegistryConfigInput, setup } from "rivetkit";
import { decodeBridgeRivetError } from "rivetkit/errors";
import type * as Actor from "./actor.ts";
import { EngineUnavailable } from "./errors.ts";
import * as ExitGuard from "./node/exit-guard.ts";

/** Options of `serve`: the actors, and rivetkit's `setup` options, passed on unchanged. */
export interface ServeOptions extends Omit<RegistryConfigInput<RegistryActors>, "use"> {
	readonly actors: ReadonlyArray<Actor.Any>;
	/** rivetkit actor definitions of the product's own, registered beside `actors` under the names given here. */
	readonly use?: RegistryActors;
}

/** The actors by the name each is registered under: the `use` of a registry a product sets up itself. */
export function use(actors: ReadonlyArray<Actor.Any>): RegistryActors {
	return Object.fromEntries(actors.map((definition) => [definition.name, definition.rivet]));
}

/**
 * Starts a registry of `actors` and succeeds once it has registered with the engine; closing the scope drains it and
 * stops what it started. Which engine it is: `endpoint` names one that runs already (a Rivet deployment);
 * `startEngine: true` with `enginePort` starts the engine binary of rivetkit's platform package beside this process,
 * with its data under the directory `RIVETKIT_STORAGE_PATH` names.
 *
 * A start that fails or is interrupted shuts its registry down before this Effect ends, and fails with
 * `EngineUnavailable`: `code` is Rivet's `group.code` when rivetkit said why (`engine.health_check_failed`), else
 * `start`.
 *
 * rivetkit owns three things an Effect cannot take back:
 *
 * - It installs SIGINT and SIGTERM handlers unless `shutdown.disableSignalHandlers` is set.
 * - It exits the process (`process.exit(1)`) when a registry's serve call fails: when its connection to the engine
 *   fails after the start, and when a start with `startEngine` gets no healthy engine. That second exit comes about
 *   a minute after the start began, 64 health checks later, also when this Effect failed long before and shut the
 *   registry down. The local engine entries (`/node`, `/bun`) hold it back for their own failed starts, and
 *   `holdBackExit` holds every such exit back.
 * - A shutdown does not stop an engine that never became healthy: rivetkit stops that process only when its health
 *   checks run out. The local engine entries stop it themselves.
 */
export function serve(options: ServeOptions): Effect.Effect<void, EngineUnavailable, Scope.Scope> {
	const { actors, use: others, ...config } = options;
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const registry = yield* Effect.try({
				try: () => setup({ ...config, use: { ...others, ...use(actors) } }),
				catch: startFailure,
			});
			const started = yield* Effect.exit(
				restore(Effect.tryPromise({ try: () => registry.startAndWait(), catch: startFailure })),
			);
			if (Exit.isSuccess(started)) {
				return yield* Effect.addFinalizer(() => Effect.promise(() => registry.shutdown()));
			}
			// rivetkit waits in `shutdown` for the serve call of a start that failed, for as long as its grace period:
			// the registry is shut down at once, and that wait is not this Effect's.
			yield* Effect.timeoutOption(
				Effect.promise(() => registry.shutdown()),
				FAILED_START_SHUTDOWN_MILLIS,
			);
			return yield* Effect.failCause(started.cause);
		}),
	);
}

const FAILED_START_SHUTDOWN_MILLIS = 2_000;

/**
 * From now on, for as long as the process lives, an exit of the process that rivetkit asks for does nothing: the
 * process ends when its owner says. Run it before `serve` in a process that hosts several engines, or other work
 * beside its actors: without it rivetkit ends the process when one registry loses its engine. The registry of a lost
 * engine stays as it is; calls of its actors fail with `EngineUnavailable`.
 */
export const holdBackExit: Effect.Effect<void> = ExitGuard.keep;

/** Why a registry did not start: rivetkit's own error when it carries one, else whatever was thrown. */
function startFailure(cause: unknown): EngineUnavailable {
	const message = Predicate.isError(cause) ? cause.message : String(cause);
	// rivetkit's native core reports through an error whose message holds the encoded error.
	const rivet = decodeBridgeRivetError(message);
	return rivet === undefined
		? new EngineUnavailable({ code: "start", message, retryable: false })
		: new EngineUnavailable({ code: `${rivet.group}.${rivet.code}`, message: rivet.message, retryable: false });
}
