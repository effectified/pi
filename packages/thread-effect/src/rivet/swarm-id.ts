// How a swarm of a thread actor is named: its id begins with its thread's key, so the id alone finds the actor the
// swarm's coordinator lives in.

import { Effect, Schema } from "effect";

/** What stands between the thread's key and the swarm's own name in a swarm id. */
const SEPARATOR = "/";

/**
 * The swarm id does not name the thread: it is not `<thread>/<name>` with a name that is not empty and has no `/`.
 * `thread` is the thread the swarm was to run on; absent when the id was given alone and names no thread at all.
 */
export class SwarmIdNotOfThread extends Schema.TaggedError<SwarmIdNotOfThread>()("SwarmIdNotOfThread", {
	swarmId: Schema.String,
	thread: Schema.optional(Schema.String),
}) {
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
export function of(thread: string, name: string): string {
	return `${thread}${SEPARATOR}${name}`;
}

/** The key of the thread a swarm id names; fails with `SwarmIdNotOfThread` for an id that names none. */
export function threadOf(swarmId: string): Effect.Effect<string, SwarmIdNotOfThread> {
	const at = swarmId.lastIndexOf(SEPARATOR);
	return at > 0 && at < swarmId.length - 1
		? Effect.succeed(swarmId.slice(0, at))
		: Effect.fail(new SwarmIdNotOfThread({ swarmId }));
}

/** Succeeds when `swarmId` names the thread `thread`; fails with `SwarmIdNotOfThread` otherwise. */
export function ofThread(thread: string, swarmId: string): Effect.Effect<void, SwarmIdNotOfThread> {
	return Effect.matchEffect(threadOf(swarmId), {
		onFailure: () => Effect.fail(new SwarmIdNotOfThread({ swarmId, thread })),
		onSuccess: (named) => (named === thread ? Effect.void : Effect.fail(new SwarmIdNotOfThread({ swarmId, thread }))),
	});
}
