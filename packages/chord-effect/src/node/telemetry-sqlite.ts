// `@effectified/pi-chord/telemetry-sqlite/node`: a telemetry store file on Node, opened read-only for the life of a
// scope.

import {
	openTelemetryStore as piOpenTelemetryStore,
	type SqliteTelemetryStore,
} from "@earendil-works/chord/telemetry-sqlite/node";
import { Effect, type Scope } from "effect";
import type { SqliteError } from "../errors.ts";
import { settled } from "../settled.ts";

// Chord's read-only store type.
export type * from "@earendil-works/chord/telemetry-sqlite/node";
export { SqliteError } from "../errors.ts";

/**
 * Chord's `openTelemetryStore`: the telemetry store at `path`, read-only (never written, migrated or created), while
 * recorders of other processes write it; closed when the scope closes. Read it with `findTraces`, `getTrace` and
 * `findMetrics` of `@effectified/pi-chord/telemetry-sqlite`. Fails with `SqliteError` for a file that holds no store or
 * a store of another version.
 */
export function openTelemetryStore(path: string): Effect.Effect<SqliteTelemetryStore, SqliteError, Scope.Scope> {
	return Effect.acquireRelease(
		settled(() => piOpenTelemetryStore(path)),
		// A close that fails leaves nothing to recover in a finalizer.
		(store) => Effect.ignore(settled(() => store.close())),
	);
}
