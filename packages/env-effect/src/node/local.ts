// A local execution environment: Pi Durable's Node environment, listing files through a daemon on this machine.

import { LocalExecutionEnv, type LocalExecutionEnvOptions } from "@earendil-works/pi-env";
import { Effect, type Layer } from "effect";
import * as Env from "../env.ts";
import type { Connection } from "./connection.ts";

/**
 * Pi's options of a local environment, with this package's connection: one to this machine's daemon
 * (`Connection.make({ command: [daemon] })`), used only by `listFiles`. Several environments may share it.
 */
export type Options = Omit<LocalExecutionEnvOptions, "connection"> & { readonly connection: Connection };

/** A local environment; closing the scope kills the commands it still runs. */
export const make = Effect.fn("Local.make")(function* (options: Options) {
	const pi = yield* Env.owned(create(options));
	return yield* Env.fromPi(pi);
});

/** `Env.Current` as a local environment, its commands killed when the Layer is released. */
export function layer(options: Options): Layer.Layer<Env.Current> {
	return Env.layer(create(options));
}

/** Pi's local environment of `options`. */
function create(options: Options): Effect.Effect<LocalExecutionEnv> {
	return Effect.sync(() => new LocalExecutionEnv({ ...options, connection: options.connection.pi }));
}
