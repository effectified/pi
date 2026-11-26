// The storage a harness runs on, as a service: memory, SQLite over any Effect `SqlClient` or a Chord SQLite database,
// or a Pi storage of your own.

import { MemoryStorage, type Storage as PiStorage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { StrictOmit } from "@effectified/pi-ai";
import type { SqliteDatabase } from "@effectified/pi-chord/sqlite";
import { Context, Effect, Layer, type Scope } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { call } from "./call.ts";
import type { DurableError } from "./errors.ts";
import * as SqlDatabase from "./sql-database.ts";

/**
 * The Pi Durable `Storage` a harness opens. The harness closes it when it closes; closing the Layer's scope closes it
 * when no harness did. Either way the storage behind it is closed once.
 */
export class HarnessStorage extends Context.Service<HarnessStorage, PiStorage>()(
	"@effectified/pi-durable/HarnessStorage",
) {}

/** Storage that keeps everything in memory: Pi's `MemoryStorage`, a fresh one per build of the Layer. */
export const memory: Layer.Layer<HarnessStorage> = Layer.effect(
	HarnessStorage,
	scoped(Effect.sync(() => new MemoryStorage())),
);

/** Options of `sql`. */
export interface SqlOptions {
	/** Namespaces Pi's tables and indexes in a shared database, such as `"pi_"`. Changing it migrates nothing. */
	readonly prefix?: string;
}

/**
 * Pi's SQLite storage on the `SqlClient` of the context, which must speak the SQLite dialect (Bun, Node, wasm,
 * Durable Objects). Building the Layer applies Pi's migrations. The client stays open: its own Layer closes it.
 */
export function sql(options?: SqlOptions): Layer.Layer<HarnessStorage, DurableError, SqlClient> {
	return Layer.effect(
		HarnessStorage,
		Effect.flatMap(SqlDatabase.make, (database) =>
			scoped(call(() => SqliteStorage.open(database, { prefix: options?.prefix }))),
		),
	);
}

/**
 * Pi's SQLite storage on a Chord `SqliteDatabase` (`@effectified/pi-chord/sqlite`), such as a Rivet actor's database
 * or one of `@effectified/pi-chord/sqlite/node`. Building the Layer applies Pi's migrations. Pi's storage closes the
 * database when it closes: hand it a database the storage may own.
 */
export function sqlite(database: SqliteDatabase, options?: SqlOptions): Layer.Layer<HarnessStorage, DurableError> {
	return Layer.effect(HarnessStorage, scoped(call(() => SqliteStorage.open(database, { prefix: options?.prefix }))));
}

/** A Pi `Storage` of your own, or an Effect that opens one, such as a custom backend or Pi's JSONL storage. */
export function custom<E = never, R = never>(
	storage: PiStorage | Effect.Effect<PiStorage, E, R>,
): Layer.Layer<HarnessStorage, E, Exclude<R, Scope.Scope>> {
	return Layer.effect(HarnessStorage, scoped(Effect.isEffect(storage) ? storage : Effect.succeed(storage)));
}

/** Opens a storage for the scope: the service value closes at most once, and the scope closes it if nothing else did. */
function scoped<E, R>(open: Effect.Effect<PiStorage, E, R>): Effect.Effect<PiStorage, E, R | Scope.Scope> {
	return Effect.acquireRelease(Effect.map(open, closeOnce), (storage) =>
		Effect.orDie(call((context) => storage.close(context))),
	);
}

/**
 * `storage` with a `close` that reaches it once: a harness closes its storage, and so does the scope that opened it,
 * while a Pi storage may reject a second close. The methods are bound once, so a call costs nothing more. Every
 * method of Pi's `Storage` is forwarded by name, the optional `publishing` only when the storage has it: a method Pi
 * adds fails to compile here until it is forwarded.
 */
function closeOnce(storage: PiStorage): PiStorage {
	let closing: Promise<void> | undefined;
	const publishing = storage.publishing?.bind(storage);
	const forwarded = {
		commit: storage.commit.bind(storage),
		mintId: storage.mintId.bind(storage),
		conversation: storage.conversation.bind(storage),
		scanConversations: storage.scanConversations.bind(storage),
		entry: storage.entry.bind(storage),
		findLatestHeadMarker: storage.findLatestHeadMarker.bind(storage),
		scanEntries: storage.scanEntries.bind(storage),
		task: storage.task.bind(storage),
		scanTasks: storage.scanTasks.bind(storage),
		submission: storage.submission.bind(storage),
		scanSubmissions: storage.scanSubmissions.bind(storage),
		submissionByRequest: storage.submissionByRequest.bind(storage),
		findDocument: storage.findDocument.bind(storage),
		document: storage.document.bind(storage),
		scanDocuments: storage.scanDocuments.bind(storage),
		close: (context) => {
			closing ??= storage.close(context);
			return closing;
		},
	} satisfies StrictOmit<Required<PiStorage>, "publishing">;
	return publishing === undefined ? forwarded : { ...forwarded, publishing };
}
