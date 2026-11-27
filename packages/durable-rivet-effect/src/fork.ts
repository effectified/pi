// A forked actor, as a product sees it: the hygiene it runs on the copied storage, and where the actor came from.

import type { Harness } from "@effectified/pi-durable";
import { type Effect, Schema } from "effect";
import { ActorInfo, type ActorSql, ForkLink } from "./actor-context.ts";

/**
 * One step of a product's fork hygiene: an Effect that makes a storage copied from another actor safe to continue,
 * such as moving a recorder's cursors to the copied head, dropping copied budget shares, or ending a background task
 * of the product that the copy holds live (the one kind of live work a fork is not refused for). It runs inside the fork,
 * in the order given, on a harness that is open but not resumed (no task runs, nothing is scheduled), with the
 * actor's identity and database (`ActorInfo`, `ActorSql`), the product's `layer` and without its `services`, before
 * the fork's first call. It must be idempotent: after a crash in the middle, every step runs again. Whatever it fails
 * with fails the fork's start, so its error is any.
 */
export type Hygiene<R> = Effect.Effect<void, unknown, Harness.Harness | ActorInfo | ActorSql | R>;

/** Where an actor came from, inside the actor and as it crosses the boundary (`Client.lineage`). */
export const Lineage = Schema.Struct({
	/** The actor forks behind this actor, oldest first; empty when it was never forked. */
	chain: Schema.Array(ForkLink),
	/** The `input` the newest fork was made with; none for an actor that is not a fork, or a fork made without one. */
	input: Schema.Option(Schema.Json),
});

/** Where an actor came from. */
export type Lineage = typeof Lineage.Type;

/** The lineage of the actor this Effect runs in. */
export const lineage: Effect.Effect<Lineage, never, ActorInfo> = ActorInfo.useSync((info) => ({
	chain: info.forkChain,
	input: info.forkInput,
}));
