// A Chord reference's members in Effect terms: its methods called as Effects, its state and members as Streams.

import type { RefState } from "@earendil-works/chord";
import type { Context as ChordContext, Context } from "@earendil-works/chord/context";
import type { NativeWatchable } from "@earendil-works/chord/watch";
import type { Effect, Stream } from "effect";
import { chordCall } from "./call.ts";
import type { ChordCallError } from "./errors.ts";
import { values, type WatchError } from "./watch.ts";

/**
 * Calls `method`, a method of a reference (`reference.greet`), with `args`, under a context of the fiber: its
 * `ParentContext` (inside a facet's Effect handler, the handler's `ctx`) under its current span. Interrupting the
 * fiber cancels the call. Fails with Chord's error as `ChordCallError`: what the method declares (`invalid`,
 * `forbidden`), a plugin's own (`PluginFailed`), or why the call could not be made (`released`, `unavailable`).
 */
export function call<Args extends readonly unknown[], A>(
	method: (...params: [...Args, ChordContext]) => Promise<A>,
	...args: Args
): Effect.Effect<A, ChordCallError> {
	return chordCall((context: Context) => method(...args, context));
}

/** A reference's state (loading, live, failed or released) as a Stream: the state now, then each change. */
export function state(reference: { readonly state: NativeWatchable<RefState> }): Stream.Stream<RefState, WatchError> {
	return values(reference.state);
}
