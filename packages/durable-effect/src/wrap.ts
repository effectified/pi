// Wrappers: what an extension changes of the tools and prompt sections of the extensions it is selected with.

import type { Wrap as PiWrap } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { type Invoke, invoker } from "./invocation.ts";

/**
 * A wrapper made by `Tool.wrap` or `Section.wrap`: what an extension holds in `wraps` and a registry installs. It
 * applies wherever its extension is selected, in order, to the tool or section of that name of any extension.
 */
export interface Wrap<R> {
	/** Builds Pi's wrapper; what it runs runs with the context this Effect is run in (`Registry.layer` runs it). */
	readonly registration: Effect.Effect<PiWrap, never, R>;
}

/** Any wrapper, whatever it needs. */
export interface Any {
	readonly registration: Effect.Effect<PiWrap, never, unknown>;
}

/** The services a wrapper, or each wrapper of a union, needs to run. */
export type Services<W> = W extends { readonly registration: Effect.Effect<infer _A, infer _E, infer R> } ? R : never;

/** A wrapper whose Pi form `build` makes, with an `Invoke` on the context the registration is run in. */
export function registered<R>(build: (invoke: Invoke<R>) => PiWrap): Wrap<R> {
	return { registration: Effect.map(Effect.context<R>(), (context) => build(invoker(context))) };
}
