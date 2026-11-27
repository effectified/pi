// A remote execution environment: Pi Durable's environment interface served by a pi-env daemon on another machine.

import { RemoteExecutionEnv, type RemoteExecutionEnvOptions } from "@earendil-works/pi-env";
import { Effect, type Layer } from "effect";
import * as Env from "../env.ts";
import type { Connection } from "./connection.ts";

/**
 * Pi's options of a remote environment, with this package's connection to the daemon and the environment's file
 * namespace as an `Env.Id` (`Env.Id.make("pi-env:<env name>")`).
 */
export type Options = Omit<RemoteExecutionEnvOptions, "connection" | "id"> & {
	readonly connection: Connection;
	readonly id: Env.Id;
};

/**
 * An environment whose files and commands are on the daemon's machine. Its results match Pi's Node environment
 * running there; only error messages may differ. Closing the scope kills the commands it still runs.
 */
export const make = Effect.fn("Remote.make")(function* (options: Options) {
	const pi = yield* Env.owned(create(options));
	return yield* Env.fromPi(pi);
});

/** `Env.Current` as a remote environment, its commands killed when the Layer is released. */
export function layer(options: Options): Layer.Layer<Env.Current> {
	return Env.layer(create(options));
}

/** Pi's remote environment of `options`. */
function create(options: Options): Effect.Effect<RemoteExecutionEnv> {
	return Effect.sync(() => new RemoteExecutionEnv({ ...options, connection: options.connection.pi }));
}
