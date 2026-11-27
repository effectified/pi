// What crosses the boundary of a thread actor when an operation fails: the errors a caller can tell apart.

import { Effect, Schema } from "effect";
import { ReviewerSharesFamily, ThreadNotFound } from "../errors.ts";
import { ThreadKey } from "../ids.ts";

/**
 * The operation ran in the thread's actor and failed, for a reason that is neither "no such thread" nor one the
 * operation names itself. `reason` is the tag of what it failed with (`NotHeld`, `SwarmNotFound`, `InvalidPlan`,
 * `ActorDefect` for a defect inside the actor), `message` its own words: no content of a thread is in either.
 */
export class OperationFailed extends Schema.TaggedError<OperationFailed, { readonly brand: unique symbol }>()(
	"OperationFailed",
	{ operation: Schema.String, reason: Schema.String, message: Schema.String },
) {}

/**
 * The engine could not be reached, refused for now, or did not answer in time: nothing says that the operation ran,
 * and every operation of a thread actor is safe to send again. `retryAfterMillis` is the engine's own hint.
 */
export class HostUnavailable extends Schema.TaggedError<HostUnavailable, { readonly brand: unique symbol }>()(
	"HostUnavailable",
	{
		operation: Schema.String,
		message: Schema.String,
		retryAfterMillis: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
	},
) {}

/** A wait for a thread's outcome gave up: its schedule ended while the thread still worked. */
export class StillWorking extends Schema.TaggedError<StillWorking, { readonly brand: unique symbol }>()(
	"StillWorking",
	{ thread: ThreadKey },
) {
	override get message(): string {
		return `Thread ${this.thread} still works`;
	}
}

/** What an action that finds a thread by its key fails with, as it crosses. Choose with `Failure.match`. */
export const Failure = Schema.Union([ThreadNotFound, OperationFailed]).pipe(Schema.toTaggedUnion("_tag"));

/** What an action that finds a thread by its key fails with. */
export type Failure = typeof Failure.Type;

/** What the action that starts a thread fails with, as it crosses. Choose with `StartFailure.match`. */
export const StartFailure = Schema.Union([ReviewerSharesFamily, OperationFailed]).pipe(Schema.toTaggedUnion("_tag"));

/** What the action that starts a thread fails with. */
export type StartFailure = typeof StartFailure.Type;

/** A failure inside the actor, as far as this module looks at one: its tag and its own words. */
interface Tagged {
	readonly _tag: string;
	readonly message: string;
}

/**
 * `effect` with its failures as they cross: a `ThreadNotFound` and a `ReviewerSharesFamily` as they are, anything
 * else as `OperationFailed` with its tag and its message.
 */
export function crossing<A, E extends Tagged, R>(
	operation: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Extract<E, ThreadNotFound | ReviewerSharesFamily> | OperationFailed, R> {
	return Effect.mapError(effect, (error) => {
		if (error._tag === "ThreadNotFound" || error._tag === "ReviewerSharesFamily") {
			// The two tags are those of the members `Extract` keeps: TypeScript does not narrow a type parameter by one.
			return error as Extract<E, ThreadNotFound | ReviewerSharesFamily>;
		}
		return OperationFailed.make({ operation, reason: error._tag, message: error.message });
	});
}
