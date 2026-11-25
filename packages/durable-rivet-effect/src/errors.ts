// The typed failures this host adds to a call that crosses into a Rivet actor, as a closed union of tagged errors.

import { Schema } from "effect";

/**
 * The harness in the actor has work in flight, so it was not forked, or a wait for it to become idle gave up. `tasks`
 * and `submissions` are how many live tasks and unsettled submissions Pi reported when it was last asked. A refused
 * fork counts every live task, the background tasks of the product too, which alone would not have refused it.
 */
export class NotIdle extends Schema.TaggedError<NotIdle>()("NotIdle", {
	actorId: Schema.String,
	tasks: Schema.Number,
	submissions: Schema.Number,
}) {
	override get message(): string {
		return `Actor ${this.actorId} is not idle: ${this.tasks} live tasks, ${this.submissions} unsettled submissions`;
	}
}

/** The actor does not exist: it was destroyed, or its id was never an actor's. Nothing was run. */
export class ActorGone extends Schema.TaggedError<ActorGone>()("ActorGone", {
	actor: Schema.String,
	actorId: Schema.String,
}) {
	override get message(): string {
		return `Actor ${this.actor} ${this.actorId} does not exist or was destroyed`;
	}
}

/**
 * The engine could not be reached, or refused the request. `code` is Rivet's `group.code`, or `transport` when no
 * answer came, `start` when a registry did not start, `port`, `lost` and `environment` for a local engine (a port
 * taken, an engine process that ended before it was ready, an environment that could not be set). `retryable` is
 * true for a transport failure, for a refusal the engine gave a retry hint for (`retryAfterMillis`), and for a
 * refused fork. A transport failure may come after the request reached the actor, so send again only what is safe
 * to repeat.
 */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()("EngineUnavailable", {
	code: Schema.String,
	message: Schema.String,
	retryable: Schema.Boolean,
	retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/**
 * The action ran and failed with its own error. `error` is that error, decoded with the action's error schema; `call`
 * types it.
 */
export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
	action: Schema.String,
	error: Schema.Unknown,
}) {
	override get message(): string {
		return `Action ${this.action} failed`;
	}
}

/**
 * The call failed inside the actor and not with the action's own error: a defect of the handler, a harness that could
 * not open, an input or an output its schema rejects, Rivet's action timeout. `message` is the defect's message, which
 * crosses as data and is never logged by this package.
 */
export class ActorDefect extends Schema.TaggedError<ActorDefect>()("ActorDefect", {
	action: Schema.String,
	message: Schema.String,
}) {}

/** The key asked for a fork is held by an actor that is not a fork of this source, so no fork was made. */
export class ForkKeyHeld extends Schema.TaggedError<ForkKeyHeld>()("ForkKeyHeld", {
	actor: Schema.String,
	key: Schema.Array(Schema.String),
	heldBy: Schema.String,
}) {
	override get message(): string {
		return `Key ${JSON.stringify(this.key)} of ${this.actor} is held by actor ${this.heldBy}, which is not a fork of the source`;
	}
}

/** Every failure this host adds. */
export type HostError = NotIdle | ActorGone | EngineUnavailable | ActionFailed | ActorDefect | ForkKeyHeld;

/** What a call to any action can fail with besides the action's own error. */
export type CallError = ActorGone | EngineUnavailable | ActorDefect;
