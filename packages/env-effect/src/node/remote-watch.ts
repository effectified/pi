// A watcher running in a pi-env daemon next to the files, as a scoped resource whose changes are a Stream.

import { RemoteWatcher, type RemoteWatchOptions } from "@earendil-works/pi-env";
import type { WatchTarget } from "@effectified/pi-durable/env";
import { Effect } from "effect";
import * as Watcher from "../watcher.ts";
import type { Connection } from "./connection.ts";
import { remote } from "./rejection.ts";

/**
 * Watches `targets` (absolute paths of the daemon's machine) until the scope closes. When the connection is lost,
 * Pi opens the watcher again once the connection starts again and reports `overflow`: changes in between were not
 * seen. Fails like Pi's local watcher when coverage cannot be established.
 */
export const open = Effect.fn("RemoteWatch.open")(
	(connection: Connection, targets: ReadonlyArray<WatchTarget>, options?: RemoteWatchOptions) =>
		Watcher.acquire((onChange) => remote(() => RemoteWatcher.open(connection.pi, targets, onChange, options))),
);
