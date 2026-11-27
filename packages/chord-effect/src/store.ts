// Chord's store in Effect: opened or imported for the life of a scope, its commits and archives as Streams.

import {
	type Address,
	type ArchivePart,
	type Backend,
	type HostArchive,
	decodeJsonl as piDecodeJsonl,
	encodeJsonl as piEncodeJsonl,
	exportHostData as piExportHostData,
	importStore as piImportStore,
	openStore as piOpenStore,
	readHostArchive as piReadHostArchive,
	type Store,
	type StoreOptions,
} from "@earendil-works/chord";
import { Effect, Queue, type Scope, Stream } from "effect";
import { dual } from "effect/Function";
import { attempt, rejection, storeRejection } from "./call.ts";
import type { ChordCallError, SqliteError } from "./errors.ts";
import { fromIterable, toIterable } from "./iterable.ts";

// Chord's store types, under this module (`Store.Store`): the store, its options and archives.
export type {
	ArchiveManifest,
	ArchivePart,
	Backend,
	HostArchive,
	HostDataCounts,
	HostImportOptions,
	Outbox,
	OutboxCommit,
	Store,
	StoreOptions,
} from "@earendil-works/chord";

/** What a store call fails with: Chord's error classes, or the database's own error. */
export type StoreError = ChordCallError | SqliteError;

/**
 * Chord's `openStore`: the store on `backend` (`sqliteBackend(database)`), closed when the scope closes. The value is
 * Chord's own `Store`, so it goes where Chord takes one: a host's `store`, `Storage.store` of
 * `@effectified/pi-durable/storage/store`. A failure closes the backend.
 */
export function open(backend: Backend, options?: StoreOptions): Effect.Effect<Store, StoreError, Scope.Scope> {
	return Effect.acquireRelease(
		attempt((context) => piOpenStore(backend, context, options), storeRejection),
		close,
	);
}

/**
 * Chord's `importStore`: a store on `backend`, which must hold none yet, made of the archive `parts` (an export's, or
 * `decodeJsonl` of its bytes), closed when the scope closes. A refused archive fails `ChordFailed` (`invalid/args`);
 * a failure of `parts` fails with that failure. Either way the backend is closed.
 */
export function importArchive<E, R>(
	backend: Backend,
	parts: Stream.Stream<unknown, E, R>,
	options?: StoreOptions,
): Effect.Effect<Store, StoreError | E, Scope.Scope | R> {
	return Effect.flatMap(toIterable(parts), (input) =>
		Effect.acquireRelease(
			attempt((context) => piImportStore(backend, input.iterable, context, options), input.rejected(storeRejection)),
			close,
		),
	);
}

/** Closes `store`; a close that fails leaves nothing to recover in a finalizer: Chord closes the backend whatever it says. */
function close(store: Store): Effect.Effect<void> {
	return Effect.ignore(attempt((context) => store.close(context), storeRejection));
}

/** The seq of the store's last commit (0 for a new store). */
export function lastSeq(store: Store): Effect.Effect<number> {
	return Effect.sync(() => store.lastSeq);
}

/**
 * The store's `lastSeq` after each publication of commits (`onCommitted`): durable and adopted, once for however many
 * commits a publication covers. The stream starts with the next publication and runs until its scope closes.
 */
export function committed(store: Store): Stream.Stream<number> {
	return Stream.callback<number>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				store.onCommitted(
					(seq) => {
						Queue.offerUnsafe(queue, seq);
					},
					// The listener above never throws, so Chord never removes it.
					() => {},
				),
			),
			(remove) => Effect.sync(remove),
		),
	);
}

/**
 * The store's state after its `lastSeq` as archive parts (Chord's `store.export`). Reading holds the store's commit
 * queue from the first part until the stream ends, fails or its scope closes.
 */
export function archive(store: Store): Stream.Stream<ArchivePart, StoreError> {
	return fromIterable((context) => store.export(context), storeRejection);
}

/**
 * Chord's `exportHostData`: the records and rows of `store` belonging to `address` as a host's data archive, holding
 * the commit queue as `archive` does. Data-first or data-last (`pipe(store, Store.hostArchive(address))`).
 */
export const hostArchive: {
	(address: Address): (store: Store) => Stream.Stream<ArchivePart, StoreError>;
	(store: Store, address: Address): Stream.Stream<ArchivePart, StoreError>;
} = dual(2, (store: Store, address: Address): Stream.Stream<ArchivePart, StoreError> =>
	fromIterable((context) => piExportHostData(store, address, context), storeRejection),
);

/**
 * Chord's `readHostArchive`: reads and checks a host's data archive (a trust boundary), every part in archive order.
 * A refused archive fails `ChordFailed` (`invalid/args`); a failure of `parts` fails with that failure.
 */
export function readHostArchive<E, R>(
	parts: Stream.Stream<unknown, E, R>,
): Effect.Effect<HostArchive, ChordCallError | E, R> {
	return Effect.flatMap(toIterable(parts), (input) =>
		attempt((context) => piReadHostArchive(input.iterable, context), input.rejected(rejection)),
	);
}

/** Chord's `encodeJsonl`: archive parts as JSONL bytes, in chunks of whole lines. */
export function encodeJsonl<E, R>(parts: Stream.Stream<ArchivePart, E, R>): Stream.Stream<Uint8Array, E, R> {
	return Stream.unwrap(
		Effect.map(toIterable(parts), (input) =>
			// Chord's encoder throws only what it reads, the Stream's failure: anything else is a defect.
			fromIterable(() => piEncodeJsonl(input.iterable), input.rejected(Effect.die)),
		),
	);
}

/**
 * Chord's `decodeJsonl`: the values of JSONL bytes, one per nonempty line, for `importArchive` or `readHostArchive` to
 * check. Bytes that are no UTF-8 and a line that is no JSON fail `ChordFailed` (`invalid/args`).
 */
export function decodeJsonl<E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<unknown, ChordCallError | E, R> {
	return Stream.unwrap(
		Effect.map(toIterable(bytes), (input) =>
			fromIterable(() => piDecodeJsonl(input.iterable), input.rejected(rejection)),
		),
	);
}
