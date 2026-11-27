// The typed failures of the host operations and of the fork setup port: a plan that cannot run, a swarm that is not
// there, a value off its schema, a fork the product refused.

import { Schema } from "effect";
import { SwarmId } from "./ids.ts";

/** `start` got a plan it cannot run: nothing was stored. */
export class InvalidPlan extends Schema.TaggedError<InvalidPlan, { readonly brand: unique symbol }>()("InvalidPlan", {
	swarmId: SwarmId,
	reason: Schema.String,
}) {
	override get message(): string {
		return `Swarm ${this.swarmId} cannot start: ${this.reason}`;
	}
}

/** `start` found the swarm id held by a swarm of another definition: an id names one swarm. */
export class SwarmIdTaken extends Schema.TaggedError<SwarmIdTaken, { readonly brand: unique symbol }>()(
	"SwarmIdTaken",
	{
		swarmId: SwarmId,
		/** The definition of the swarm that holds the id. */
		heldBy: Schema.String,
	},
) {
	override get message(): string {
		return `Swarm id ${this.swarmId} is held by a swarm of ${this.heldBy}`;
	}
}

/** No swarm was started under this id in this harness storage. */
export class SwarmNotFound extends Schema.TaggedError<SwarmNotFound, { readonly brand: unique symbol }>()(
	"SwarmNotFound",
	{ swarmId: SwarmId },
) {
	override get message(): string {
		return `No swarm ${this.swarmId}`;
	}
}

/**
 * The swarm has no result to give: Pi faulted its coordinator (a restart limit, a bug in a phase) or orphaned it (its
 * definition was not installed when it was aborted), it was copied with its storage, or what it stored is not this
 * version's. Its forks are still listed by the driver.
 */
export class SwarmFaulted extends Schema.TaggedError<SwarmFaulted, { readonly brand: unique symbol }>()(
	"SwarmFaulted",
	{ swarmId: SwarmId, reason: Schema.String },
) {
	override get message(): string {
		return `Swarm ${this.swarmId} ended without a result: ${this.reason}`;
	}
}

/** A job input or a job result does not match its schema. `issues` is Effect's own report. */
export class InvalidValue extends Schema.TaggedError<InvalidValue, { readonly brand: unique symbol }>()(
	"InvalidValue",
	{ what: Schema.Literals(["input", "result"]), issues: Schema.String },
) {
	override get message(): string {
		return `The job ${this.what} does not match its schema: ${this.issues}`;
	}
}

/**
 * The product's `ForkSetup` refused a fork: what its port fails with. `reason` becomes the message of the failed job,
 * which a host reads; `cause` is the product's own failure.
 */
export class ForkSetupFailed extends Schema.TaggedError<ForkSetupFailed, { readonly brand: unique symbol }>()(
	"ForkSetupFailed",
	{ reason: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {
	override get message(): string {
		return `The fork could not be set up: ${this.reason}`;
	}
}
