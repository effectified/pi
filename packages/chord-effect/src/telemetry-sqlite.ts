// `@effectified/pi-chord/telemetry-sqlite`: Chord's SQLite telemetry store, recording for the life of a scope and read
// through Effects.

import {
	createSqliteTelemetry as piCreateSqliteTelemetry,
	type SqliteTelemetry,
	type SqliteTelemetryOptions,
} from "@earendil-works/chord/telemetry-sqlite";
import type { MetricQuery, StoredMetric, StoredTrace, TelemetryStore, TraceQuery } from "@effectified/pi-telemetry";
import { Effect, type Scope } from "effect";
import type { SqliteError } from "./errors.ts";
import { settled } from "./settled.ts";
import type { SqliteDatabase } from "./sqlite.ts";

// Chord's telemetry store types (`SqliteTelemetry`, its options, a batch of another process's spans).
export type * from "@earendil-works/chord/telemetry-sqlite";
export { SqliteError } from "./errors.ts";

/**
 * Chord's `createSqliteTelemetry`: a telemetry adapter that records into `database`, migrated first, until the scope
 * closes, which stops recording and drains what is pending (partial metric intervals too); the database stays open,
 * its owner's to close. The value is Chord's own: a Pi `TelemetryContext` (a host's `telemetry`, a harness's) and a
 * `TelemetryStore`. A timer writes settled spans every second. Fails with `SqliteError` when the migration fails.
 */
export function make(
	database: SqliteDatabase,
	options?: SqliteTelemetryOptions,
): Effect.Effect<SqliteTelemetry, SqliteError, Scope.Scope> {
	return Effect.acquireRelease(
		settled(() => piCreateSqliteTelemetry(database, options)),
		// A drain that fails leaves nothing to recover in a finalizer: recording has stopped whatever it says.
		(telemetry) => Effect.ignore(settled(() => telemetry.close())),
	);
}

/** Writes the settled spans and completed metric intervals now; fails with the write's error, which stops recording. */
export function flush(telemetry: SqliteTelemetry): Effect.Effect<void, SqliteError> {
	return settled(() => telemetry.flush());
}

/** The traces of `store` that `query` selects (Pi's `TelemetryStore.findTraces`), a page and its continuation. */
export function findTraces(
	store: TelemetryStore,
	query?: TraceQuery,
): Effect.Effect<{ readonly traces: readonly StoredTrace[]; readonly cursor?: string }, SqliteError> {
	return settled(() => store.findTraces(query));
}

/** The trace `traceId` of `store`, if it holds one (Pi's `TelemetryStore.getTrace`). */
export function getTrace(store: TelemetryStore, traceId: string): Effect.Effect<StoredTrace | undefined, SqliteError> {
	return settled(() => store.getTrace(traceId));
}

/** The metric intervals of `store` that `query` selects (Pi's `TelemetryStore.findMetrics`). */
export function findMetrics(
	store: TelemetryStore,
	query: MetricQuery,
): Effect.Effect<readonly StoredMetric[], SqliteError> {
	return settled(() => store.findMetrics(query));
}
