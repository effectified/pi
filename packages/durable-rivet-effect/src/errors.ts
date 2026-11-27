// The typed failures this host adds to a call that crosses into a Rivet actor, as a closed union of tagged errors.

import { Formatter, Schema } from "effect";
import { ActorId, ActorKey } from "./ids.ts";

// A number of tasks or submissions, as Pi counts them.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * The harness in the actor has work in flight, so it was not forked, or a wait for it to become idle gave up. `tasks`
 * and `submissions` are how many live tasks and unsettled submissions Pi reported when it was last asked. A refused
 * fork counts every live task, the background tasks of the product too, which alone would not have refused it.
 */
export class NotIdle extends Schema.TaggedError<NotIdle, { readonly brand: unique symbol }>()("NotIdle", {
	actorId: ActorId,
	tasks: Count,
	submissions: Count,
}) {
	override get message(): string {
		return `Actor ${this.actorId} is not idle: ${this.tasks} live tasks, ${this.submissions} unsettled submissions`;
	}
}

/** The actor does not exist: it was destroyed, or its id was never an actor's. Nothing was run. */
export class ActorGone extends Schema.TaggedError<ActorGone, { readonly brand: unique symbol }>()("ActorGone", {
	actor: Schema.String,
	actorId: ActorId,
}) {
	override get message(): string {
		return `Actor ${this.actor} ${this.actorId} does not exist or was destroyed`;
	}
}

/**
 * The engine could not be reached, or refused the request. `code` is Rivet's `group.code`, or `transport` when no
 * answer came, `start` when a registry did not start, `port`, `lost` and `environment` for a local engine (a port
 * taken, an engine process that ended before it was ready, an environment that could not be set, a directory or file
 * of the engine that could not be made or read, a process list that could not be read). `retryable` is
 * true for a transport failure, for a refusal the engine gave a retry hint for (`retryAfterMillis`), and for a
 * refused fork. A transport failure may come after the request reached the actor, so send again only what is safe
 * to repeat.
 */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable, { readonly brand: unique symbol }>()(
	"EngineUnavailable",
	{
		code: Schema.String,
		message: Schema.String,
		retryable: Schema.Boolean,
		retryAfterMillis: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
	},
) {}

/**
 * The action ran and failed with its own error. `error` is that error, decoded with the action's error schema; `call`
 * types it.
 */
export class ActionFailed extends Schema.TaggedError<ActionFailed, { readonly brand: unique symbol }>()(
	"ActionFailed",
	{ action: Schema.String, error: Schema.Unknown },
) {
	override get message(): string {
		return `Action ${this.action} failed`;
	}
}

/**
 * The call failed inside the actor and not with the action's own error: a defect of the handler, a harness that could
 * not open, an input or an output its schema rejects, Rivet's action timeout. `message` is the defect's message, which
 * crosses as data and is never logged by this package.
 */
export class ActorDefect extends Schema.TaggedError<ActorDefect, { readonly brand: unique symbol }>()("ActorDefect", {
	action: Schema.String,
	message: Schema.String,
}) {}

/** The key asked for a fork is held by an actor that is not a fork of this source, so no fork was made. */
export class ForkKeyHeld extends Schema.TaggedError<ForkKeyHeld, { readonly brand: unique symbol }>()("ForkKeyHeld", {
	actor: Schema.String,
	key: ActorKey,
	heldBy: ActorId,
}) {
	override get message(): string {
		return `Key ${Formatter.formatJson(this.key)} of ${this.actor} is held by actor ${this.heldBy}, which is not a fork of the source`;
	}
}

/**
 * The actor cannot be forked, now or later: its storage is a copy of a copy as many times over as the engine allows
 * (16 in rivetkit 3.1.1). `reason` is the engine's own sentence, which says the limit. The actor itself works on.
 */
export class ForkTooDeep extends Schema.TaggedError<ForkTooDeep, { readonly brand: unique symbol }>()("ForkTooDeep", {
	actor: Schema.String,
	actorId: ActorId,
	reason: Schema.String,
}) {
	override get message(): string {
		return `Actor ${this.actor} ${this.actorId} cannot be forked: ${this.reason}`;
	}
}

/**
 * Every failure this host adds, as one closed union: `HostError.match` picks a handler per tag and `HostError.guards`
 * tests for one.
 */
export const HostError = Schema.Union([
	NotIdle,
	ActorGone,
	EngineUnavailable,
	ActionFailed,
	ActorDefect,
	ForkKeyHeld,
	ForkTooDeep,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure this host adds. */
export type HostError = typeof HostError.Type;

/** What a call to any action can fail with besides the action's own error, as a closed union like `HostError`. */
export const CallError = Schema.Union([ActorGone, EngineUnavailable, ActorDefect]).pipe(Schema.toTaggedUnion("_tag"));

/** What a call to any action can fail with besides the action's own error. */
export type CallError = typeof CallError.Type;
