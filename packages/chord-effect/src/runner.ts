// The bridge from Chord to Effect: an Effect run as the promise Chord awaits from a handler, a route's resolve or a
// root scope, with the services it was given.

import { ChordError as PiChordError, PluginError as PiPluginError } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { Cause, type Context, Effect, Exit, Formatter, Predicate } from "effect";
import type { ChordCallError } from "./errors.ts";
import { ParentContext } from "./parent-context.ts";

/**
 * Runs an Effect under the Chord context `parent` (its `ParentContext`), interrupted when `parent` is cancelled. A
 * failure, a defect and the interruption reject: `ChordFailed` and `PluginFailed` as Chord's own `ChordError` and
 * `PluginError`, so a caller over a link gets their code; anything else as an `Error`.
 */
export type Run<R> = <A, E>(effect: Effect.Effect<A, E, R>, parent: ChordContext) => Promise<A>;

/** A `Run` whose Effects get `context`. */
export function runner<R>(context: Context.Context<R>): Run<R> {
	const runExit = Effect.runPromiseExitWith(context);
	return (effect, parent) =>
		runExit(Effect.provideService(effect, ParentContext, parent), { signal: parent.abortSignal }).then((exit) =>
			Exit.isSuccess(exit) ? exit.value : Promise.reject(toChord(Cause.squash(exit.cause))),
		);
}

/** What Chord gets for a failure: its own error classes for the tags of `ChordCallError`, an `Error` for the rest. */
function toChord(failure: unknown): Error {
	if (isTagged(failure, "ChordFailed")) {
		// A `ChordFailed` pairs a code with a reason of its own: Chord checks the pairing of what it receives on a link.
		return new PiChordError({
			code: failure.code,
			reason: failure.reason,
			message: failure.message,
			details: failure.details,
		} as ConstructorParameters<typeof PiChordError>[0]);
	}
	if (isTagged(failure, "PluginFailed")) {
		// Effect's `Json` is Chord's `JsonValue` with read-only arrays: the same values.
		return new PiPluginError(failure.code, failure.message, failure.details as JsonValue | undefined);
	}
	if (Predicate.isError(failure) && failure.message !== "") return failure;
	return new Error(Formatter.format(failure), { cause: failure });
}

/** Whether `failure` (any value: an Effect may fail with anything) is the tagged error `tag` of this package. */
function isTagged<T extends ChordCallError["_tag"]>(
	failure: unknown,
	tag: T,
): failure is Extract<ChordCallError, { readonly _tag: T }> {
	return Predicate.isTagged(failure, tag);
}
