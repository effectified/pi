// A Pi file watcher as a scoped resource: its changes as a Stream, stopped when its scope closes.

import { BACKGROUND_CONTEXT } from "@effectified/pi-chord/context";
import type { FileChange, FileWatcher } from "@effectified/pi-durable/env";
import { Cause, Effect, Queue, type Scope, Stream } from "effect";
import { type FileFailed, fromFileError } from "./errors.ts";

/** What a watcher reports while it is healthy: Pi's `FileChange` without `failed`, which ends `changes` instead. */
export type WatchChange = Exclude<FileChange, { readonly kind: "failed" }>;

/**
 * A running watcher. Coverage is established once it exists: a change made after it opened is in `changes`, kept
 * until it is read. `changes` fails with the `FileFailed` of Pi's `failed` change, after which nothing follows, and
 * ends when the watcher's scope closes. `mode` is Pi's: `native`, or `polling` where the file system does not report
 * changes reliably (a remote watcher may switch to it).
 */
export interface Watcher {
	readonly mode: Effect.Effect<FileWatcher["mode"]>;
	readonly changes: Stream.Stream<WatchChange, FileFailed>;
}

/**
 * Opens a Pi watcher with `open`, which passes Pi the callback that collects its changes, and stops it when the
 * scope closes.
 */
export function acquire<E>(
	open: (onChange: (change: FileChange) => void) => Effect.Effect<FileWatcher, E>,
): Effect.Effect<Watcher, E, Scope.Scope> {
	return Effect.gen(function* () {
		// Unbounded: Pi's callback cannot wait, and a change must not be dropped before it is read.
		const queue = yield* Queue.unbounded<WatchChange, FileFailed | Cause.Done>();
		const watcher = yield* Effect.acquireRelease(
			open((change) => {
				if (change.kind === "failed") Queue.failCauseUnsafe(queue, Cause.fail(fromFileError(change.error)));
				else Queue.offerUnsafe(queue, change);
			}),
			(opened) => Effect.promise(() => opened.stop(BACKGROUND_CONTEXT)).pipe(Effect.andThen(Queue.end(queue))),
		);
		return { mode: Effect.sync(() => watcher.mode), changes: Stream.fromQueue(queue) };
	});
}
