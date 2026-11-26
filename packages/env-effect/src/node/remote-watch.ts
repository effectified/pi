// A watcher running in a pi-env daemon next to the files, as a scoped resource whose changes are a Stream.

import type { WatchTarget } from "@earendil-works/pi-durable/env";
import { RemoteWatcher, type RemoteWatchOptions } from "@earendil-works/pi-env";
import type { Effect, Scope } from "effect";
import type { RemoteFailed } from "../errors.ts";
import * as Watcher from "../watcher.ts";
import type { Connection } from "./connection.ts";
import { remote } from "./rejection.ts";

/**
 * Watches `targets` (absolute paths of the daemon's machine) until the scope closes. When the connection is lost,
 * Pi opens the watcher again once the connection starts again and reports `overflow`: changes in between were not
 * seen. Fails like Pi's local watcher when coverage cannot be established.
 */
export function open(
	connection: Connection,
	targets: ReadonlyArray<WatchTarget>,
	options?: RemoteWatchOptions,
): Effect.Effect<Watcher.Watcher, RemoteFailed, Scope.Scope> {
	return Watcher.acquire((onChange) => remote(() => RemoteWatcher.open(connection.pi, targets, onChange, options)));
}
