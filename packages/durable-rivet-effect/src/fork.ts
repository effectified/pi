// A forked actor, as a product sees it: the hygiene it runs on the copied storage, and where the actor came from.

import type { Harness } from "@gunta/pi-durable-effect";
import { Effect, type Option, type Schema } from "effect";
import { ActorInfo, type ForkLink } from "./actor-context.ts";

/**
 * One step of a product's fork hygiene: an Effect that makes a storage copied from another actor safe to continue,
 * such as moving a recorder's cursors to the copied head, dropping copied budget shares, or ending a background task
 * of the product that the copy holds live (the one kind of live work a fork is not refused for). It runs inside the fork,
 * in the order given, on a harness that is open but not resumed (no task runs, nothing is scheduled), with the
 * product's `layer` and without its `services`, before the fork's first call. It must be idempotent: after a crash in
 * the middle, every step runs again.
 */
export type Hygiene<R> = Effect.Effect<void, unknown, Harness.Harness | ActorInfo | R>;

/** Where an actor came from. */
export interface Lineage {
	/** The actor forks behind this actor, oldest first; empty when it was never forked. */
	readonly chain: ReadonlyArray<ForkLink>;
	/** The `input` the newest fork was made with; none for an actor that is not a fork, or a fork made without one. */
	readonly input: Option.Option<Schema.Json>;
}

/** The lineage of the actor this Effect runs in. */
export const lineage: Effect.Effect<Lineage, never, ActorInfo> = ActorInfo.use((info) =>
	Effect.succeed({ chain: info.forkChain, input: info.forkInput }),
);
