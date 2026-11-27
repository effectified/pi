// How a swarm of a thread actor is named: its id begins with its thread's key, so the id alone finds the actor the
// swarm's coordinator lives in.

import * as Swarm from "@effectified/pi-swarm";
import { Effect, Option, pipe, Schema, String as Str } from "effect";
import { ThreadKey } from "../ids.ts";

/** What stands between the thread's key and the swarm's own name in a swarm id. */
const SEPARATOR = "/";

/**
 * The swarm id does not name the thread: it is not `<thread>/<name>` with a name that is not empty and has no `/`.
 * `thread` is the thread the swarm was to run on; absent when the id was given alone and names no thread at all.
 */
export class SwarmIdNotOfThread extends Schema.TaggedError<SwarmIdNotOfThread, { readonly brand: unique symbol }>()(
	"SwarmIdNotOfThread",
	{ swarmId: Swarm.SwarmId, thread: Schema.optionalKey(ThreadKey) },
) {
	override get message(): string {
		const expected = this.thread === undefined ? "" : ` of thread ${this.thread}`;
		return `Swarm id ${this.swarmId} is not the id of a swarm${expected}: it must be <thread>${SEPARATOR}<name>, the name without "${SEPARATOR}"`;
	}
}

/**
 * The id of the swarm `name` of the thread `thread`: what a caller gives a plan as its id. `name` is the caller's own
 * key for the swarm, not empty and without `/`; the thread's key may be any text, since the name is the part after
 * the last `/`.
 */
export function of(thread: ThreadKey, name: string): Swarm.SwarmId {
	return Swarm.SwarmId.make(`${thread}${SEPARATOR}${name}`);
}

/** The key of the thread a swarm id names; fails with `SwarmIdNotOfThread` for an id that names none. */
export const threadOf = Effect.fn("SwarmId.threadOf")(function* (
	swarmId: Swarm.SwarmId,
): Effect.fn.Return<ThreadKey, SwarmIdNotOfThread> {
	const at = pipe(
		swarmId,
		Str.lastIndexOf(SEPARATOR),
		Option.filter((index) => index > 0 && index < swarmId.length - 1),
	);
	if (Option.isNone(at)) return yield* SwarmIdNotOfThread.make({ swarmId });
	return ThreadKey.make(pipe(swarmId, Str.slice(0, at.value)));
});

/** Succeeds when `swarmId` names the thread `thread`; fails with `SwarmIdNotOfThread` otherwise. */
export const ofThread = Effect.fn("SwarmId.ofThread")(function* (
	thread: ThreadKey,
	swarmId: Swarm.SwarmId,
): Effect.fn.Return<void, SwarmIdNotOfThread> {
	const named = yield* Effect.option(threadOf(swarmId));
	if (!Option.contains(named, thread)) return yield* SwarmIdNotOfThread.make({ swarmId, thread });
});
