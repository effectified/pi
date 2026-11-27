// The typed failures of this package: what pi-evals throws, as one closed union of tagged errors.

import { Predicate, Schema } from "effect";
import type { HarnessRun } from "vitest-evals/harness";

/**
 * The cases or the parameters of a plan are invalid: a discovered case is not `<eval set> > <case>`, two cases share
 * an identity, the model identity has no provider, the runs per variant are not a positive integer, or a discovery
 * file is not JSON.
 */
export class InvalidPlan extends Schema.TaggedError<InvalidPlan, { readonly brand: unique symbol }>()("InvalidPlan", {
	message: Schema.String,
}) {}

/**
 * A setting an eval run reads is missing or invalid: no model selected, an unknown documentation variant, an
 * incomplete sandbox identity, a documentation harness outside its container, or an authentication file that does
 * not exist, does not parse or has no credential for the provider.
 */
export class InvalidSetting extends Schema.TaggedError<InvalidSetting, { readonly brand: unique symbol }>()(
	"InvalidSetting",
	{ message: Schema.String },
) {}

/**
 * A system prompt is not what the eval variant needs: its rules or its documentation section are missing, or its
 * documentation section does not match the variant.
 */
export class PromptMismatch extends Schema.TaggedError<PromptMismatch, { readonly brand: unique symbol }>()(
	"PromptMismatch",
	{ message: Schema.String },
) {}

/**
 * A harness run failed: the model is unknown or has no authentication, the agent ended without an answer or with an
 * error, or cleaning up after the run failed. `run` is the partial run Pi recorded (its transcript, usage and
 * errors), or the failed run vitest-evals made when the run failed before it had one.
 */
export class RunFailed extends Schema.TaggedError<RunFailed, { readonly brand: unique symbol }>()("RunFailed", {
	message: Schema.String,
	// vitest-evals has no schema for its runs. Trust boundary: a run comes from vitest-evals' rejection, and `errors` is
	// the field every run has, partial or failed.
	run: Schema.declare((value: unknown): value is HarnessRun => Predicate.isObject(value) && "errors" in value),
	cause: Schema.Defect(),
}) {}

/** A `docker` command of the container runner could not start or exited with a failure. */
export class DockerFailed extends Schema.TaggedError<DockerFailed, { readonly brand: unique symbol }>()(
	"DockerFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Writing an artifact of a run (a session snapshot beside the observation) failed. */
export class ArtifactFailed extends Schema.TaggedError<ArtifactFailed, { readonly brand: unique symbol }>()(
	"ArtifactFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * Every failure of a call into pi-evals, as one closed union: `EvalsError.match` picks a handler per tag. Pi throws
 * plain `Error`s and `TypeError`s, not classes of its own; each function's documented failures have one tag here,
 * chosen by the function, never by the message.
 */
export const EvalsError = Schema.Union([
	InvalidPlan,
	InvalidSetting,
	PromptMismatch,
	RunFailed,
	DockerFailed,
	ArtifactFailed,
]).pipe(Schema.toTaggedUnion("_tag"));

/** Every failure of a call into pi-evals. */
export type EvalsError = typeof EvalsError.Type;

/** The message of a value Pi threw: an `Error`'s, or the value as text. */
export function messageOf(cause: unknown): string {
	// Trust boundary: a thrown value is unknown.
	return Predicate.isError(cause) ? cause.message : String(cause);
}
