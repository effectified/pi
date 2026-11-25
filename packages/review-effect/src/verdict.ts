// The verdict: what one review of one answer came to, stored as an entry of the reviewed conversation.

import { Entry, Submission, Task } from "@gunta/pi-durable-effect";
import { Schema } from "effect";
import { Finding } from "./finding.ts";

/** A model in a review, with the family the policy gave it; no `family` when the policy gave none. */
export const Party = Schema.Struct({
	provider: Schema.String,
	modelId: Schema.String,
	family: Schema.optionalKey(Schema.String),
});

/** A model in a review. */
export type Party = typeof Party.Type;

/** A finding with the name of the check that made it. */
export const Found = Schema.Struct({ check: Schema.String, ...Finding.fields });

/** A finding with the name of the check that made it. */
export type Found = typeof Found.Type;

/** A check that failed instead of answering, and what it failed with. */
export const CheckFailure = Schema.Struct({ check: Schema.String, error: Schema.String });

/** A check that failed instead of answering. */
export type CheckFailure = typeof CheckFailure.Type;

/**
 * pi-ai's whole cost of a response (`usage.cost`), in its catalog's currency: the cost of each kind of token, the
 * total, and `totalFromProvider` when the total is what the provider billed rather than the catalog's estimate.
 */
export const Cost = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	total: Schema.Number,
	totalFromProvider: Schema.optionalKey(Schema.Boolean),
});

/** pi-ai's whole cost of a response. */
export type Cost = typeof Cost.Type;

/**
 * The tokens of the reviewer's response, and pi-ai's cost of them:
 *
 * - `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`: pi-ai's counts.
 * - `cacheWrite1h`, `reasoning`: pi-ai's, when the provider reported them.
 * - `cost`: pi-ai's `usage.cost.total`.
 * - `costs`: pi-ai's whole `usage.cost`. Absent from a verdict stored before it was kept.
 */
export const Usage = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
	cacheWrite: Schema.Number,
	cacheWrite1h: Schema.optionalKey(Schema.Number),
	reasoning: Schema.optionalKey(Schema.Number),
	totalTokens: Schema.Number,
	cost: Schema.Number,
	costs: Schema.optionalKey(Cost),
});

/** The tokens of the reviewer's response, and pi-ai's cost of them. */
export type Usage = typeof Usage.Type;

/**
 * The reviewer's model request of one review, as a product records a model call:
 *
 * - `provider`, `model`: what the response names. Behind a router alias that is the route that served, not the alias.
 *   The policy's reviewer when the request ended without a response.
 * - `api`: pi-ai's api of the response; the reviewer model's when the request ended without a response.
 * - `responseModel`, `responseId`: what the provider said of its response, when it said it.
 * - `stopReason`: pi-ai's. `error` and `aborted` are a request that failed.
 * - `timestamp`: when the request started, in epoch milliseconds: the response's own, or the harness clock the
 *   request was sent at when it ended without a response.
 * - `durationMs`: from the request's start to the end of its response, when pi-ai measured it.
 * - `usage`: the response's own; absent when the request ended without a response.
 * - `error`: the provider's error text of a failed request, as pi-ai gave it.
 *
 * A verdict stored before `api`, `timestamp` and `usage.costs` were kept has none of them.
 */
export const Call = Schema.Struct({
	provider: Schema.String,
	model: Schema.String,
	api: Schema.optionalKey(Schema.String),
	responseModel: Schema.optionalKey(Schema.String),
	responseId: Schema.optionalKey(Schema.String),
	stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted", "pending", "deferred"]),
	timestamp: Schema.optionalKey(Schema.Number),
	durationMs: Schema.optionalKey(Schema.Number),
	usage: Schema.optionalKey(Usage),
	error: Schema.optionalKey(Schema.String),
});

/** The reviewer's model request of one review. */
export type Call = typeof Call.Type;

/**
 * Why an answer got no review: the family rule or a missing model stopped it, a check failed, or the review task was
 * aborted (`review_aborted`: the conversation was aborted while the review ran or waited to run again).
 */
export const Unreviewed = Schema.Literals([
	"author_family_unknown",
	"reviewer_family_unknown",
	"same_family",
	"no_reviewer_model",
	"check_failed",
	"review_aborted",
]);

/** Why an answer got no review. */
export type Unreviewed = typeof Unreviewed.Type;

/**
 * What a review decided:
 *
 * - `Passed`: no blocking finding and no failed check. The answer stands.
 * - `Corrected`: a blocking finding, and the run was sent back with a correction message.
 * - `Held`: a blocking finding and no correction left. The review task `task` waits for a person's release.
 * - `Deferred`: the reviewer's request failed, so the answer was not judged. The review task `task` waits to be asked
 *   again (`retry`); `attempt` is the number of this request for the answer, from 1.
 * - `NotReviewed`: no review was made, or it was not complete; `reason` says why. The run ends with the answer.
 */
export const Outcome = Schema.Union([
	Schema.TaggedStruct("Passed", {}),
	Schema.TaggedStruct("Corrected", {}),
	Schema.TaggedStruct("Held", { task: Task.Id }),
	Schema.TaggedStruct("Deferred", { task: Task.Id, attempt: Schema.Number }),
	Schema.TaggedStruct("NotReviewed", { reason: Unreviewed }),
]);

/** What a review decided. */
export type Outcome = typeof Outcome.Type;

/**
 * One review of one answer:
 *
 * - `answer`: the entry of the answer it is about.
 * - `inputs`: the submissions the reviewed run answers, as Pi's live run named them when the review read the run: so
 *   a verdict says which submission it held or deferred. Absent from a verdict stored before it was kept.
 * - `pass`: the number of this review within its run, from 1. A review that was deferred and asked again keeps it.
 * - `corrections`: the corrective runs this run was sent on so far, this verdict's included.
 * - `author`: the model that wrote the answer, as the answer's own message names it, with its family.
 * - `reviewer`: the model that reviewed, as the reviewer's response names it, with its family; the policy's reviewer
 *   when no response came.
 * - `call`: the reviewer's request; absent when none was sent.
 * - `findings`: every finding of every check, blocking or not, in check order.
 * - `failures`: the checks that failed instead of answering.
 * - `time`: the harness clock when the verdict was decided, in epoch milliseconds.
 */
export const Verdict = Schema.Struct({
	answer: Entry.Id,
	inputs: Schema.optionalKey(Schema.Array(Submission.Id)),
	pass: Schema.Number,
	corrections: Schema.Number,
	author: Party,
	reviewer: Party,
	call: Schema.optionalKey(Call),
	findings: Schema.Array(Found),
	failures: Schema.Array(CheckFailure),
	outcome: Outcome,
	time: Schema.Number,
});

/** One review of one answer. */
export type Verdict = typeof Verdict.Type;

/** The entry kind a verdict is stored as, in the review task's own commit. */
export const VerdictEntry = Entry.make("review.verdict", Verdict);
