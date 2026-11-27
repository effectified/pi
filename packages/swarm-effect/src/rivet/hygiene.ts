// Fork hygiene for an actor whose definition runs swarms on Rivet: a copied storage holds no swarm, no fork and no
// job of its own.

import type { Doc, Harness } from "@effectified/pi-durable";
import type { ActorInfo, ActorSql } from "@effectified/pi-durable-rivet";
import { Effect } from "effect";
import { onStorageFork } from "../storage-fork.ts";
import * as Job from "./job.ts";
import * as Records from "./records.ts";

/**
 * The entry for `Actor.make({ forkHygiene })`. The Rivet host runs it inside every fork of the actor before the
 * fork's first call, on a harness that is open and not resumed. In order:
 *
 * 1. `onStorageFork`: every coordinator the copy inherited ends `aborted` with the reason `copied` and asks the
 *    driver nothing, so it neither runs nor cancels the swarm of the actor it was copied from.
 * 2. The driver's record of forks is emptied and made the copy's own: those forks are the source's, and the copy
 *    must not list or destroy them.
 * 3. The job conversation of the source, when the source was a fork itself, is forgotten: the copy's own job starts
 *    its own.
 *
 * Idempotent, as the host asks: running it again before the fork's first call changes nothing. A fork in which it
 * did not run takes no job and drives no swarm: its driver and its `swarmRun` action refuse, and say why. A
 * `Fork.Hygiene` of `@effectified/pi-durable-rivet`, with its failures named.
 */
export const forkHygiene: Effect.Effect<
	void,
	Doc.Failure | Records.RecordFailure,
	Harness.Harness | ActorInfo | ActorSql
> = Effect.gen(function* () {
	yield* onStorageFork;
	yield* Records.claim;
	yield* Job.forget;
}).pipe(Effect.withSpan("Swarm.Rivet.forkHygiene"));
