// The review task: the durable work the `onYield` hook asks for. It runs the checks on the answer, stores the verdict
// in its own commit, and decides: the answer stands, the run continues with a correction, the task waits for a
// person, or it waits to ask a reviewer again whose request failed.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryId, TaskId } from "@earendil-works/pi-durable";
import { Hook, Task } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema, Stream } from "effect";
import type * as Check from "./check.ts";
import * as Correction from "./correction.ts";
import * as Deferral from "./deferral.ts";
import { NoAnswerUnderReview } from "./errors.ts";
import { blocks } from "./finding.ts";
import * as Hold from "./hold.ts";
import * as ModelReview from "./model-review.ts";
import { type Pairing, pair } from "./pairing.ts";
import type { ModelRef, Policy } from "./policy.ts";
import * as Report from "./report.ts";
import * as Run from "./run.ts";
import { AnswerId, type Unreviewed, type Verdict, VerdictEntry } from "./verdict.ts";

/** What a review task is built from. `R` is what the product's checks need. */
export interface Options<R> {
	readonly policy: Policy;
	/** Run after the model review, in order. */
	readonly checks: ReadonlyArray<Check.Check<R>>;
	readonly correction: Correction.Writer;
}

/** The task's kind, which Pi stores. */
export const NAME = "review.answer";

const Input = Schema.Struct({});

/**
 * `review` until the verdict is stored, `attempt` being the number of the request to the reviewer it makes, from 1;
 * `held` while the task waits for a person's decision about `answer`; `deferred` while it waits to be asked again
 * after the request number `attempt` failed.
 */
const State = Schema.Union([
	Schema.Struct({ phase: Schema.Literal("review"), attempt: Schema.Number }),
	Schema.Struct({ phase: Schema.Literal("held"), answer: AnswerId }),
	Schema.Struct({ phase: Schema.Literal("deferred"), attempt: Schema.Number }),
]);

/** The review task of an extension: what the hook asks for, and what the registry installs. */
export interface ReviewTask<R> extends Task.Task<typeof Input, typeof State, typeof Hook.YieldDecision, R> {}

/**
 * The review task for `options`. One task reviews one answer: the hook asks for a new one at every final answer, a
 * corrected one included. A task aborted while it reviews, or while it waits to review again, stores a verdict that
 * says so (`review_aborted`) and ends `aborted`: Pi then lets the run end with the answer.
 */
export function make<R>(options: Options<R>): ReviewTask<R> {
	return Task.make({
		name: NAME,
		version: 1,
		input: Input,
		state: State,
		result: Hook.YieldDecision,
		initial: () => ({ phase: "review" as const, attempt: 1 }),
		phases: {
			review: (task, api) => review(options, task.state.attempt, api),
			held: (task, api) => released(task.state.answer, api),
			deferred: (task, api) => retried(task.state.attempt, api),
		},
		abort: (task, api) => aborted(options, task.state, api),
	});
}

type Api = Task.Api<typeof Input.Type, typeof State.Type, Hook.YieldDecision>;

type Step = Task.Step<typeof State.Type, Hook.YieldDecision>;

/**
 * Reviews the answer the run yielded and commits the verdict with the task's step. Pi runs it again from its top
 * after a close or a crash that came before that commit: every check's report is a memo by then or is made again,
 * and the verdict, the correction count with it, is stored once or not at all.
 */
function review<R>(options: Options<R>, attempt: number, api: Api) {
	return Effect.gen(function* () {
		const { policy } = options;
		const yielded = yield* examined(api);
		const author = authorOf(yielded);
		// The cheap check first: a configured pair that fails the family rule costs no request.
		const configured = pair(policy, author);
		const about = aboutOf(yielded, configured);
		if (configured._tag === "Unreviewable") return yield* unreviewed(api, about, configured.reason);
		const model = api.pi.models.getModel(policy.reviewer.provider, policy.reviewer.modelId);
		if (model === undefined) return yield* unreviewed(api, about, "no_reviewer_model");
		const subject: Check.Subject = {
			conversationId: api.conversationId,
			answerId: yielded.answerId,
			answer: ModelReview.textOf(yielded.message),
			author: configured.author,
			pass: yielded.pass,
			transcript: yielded.transcript,
		};
		const reply = yield* ModelReview.once(
			api.memo,
			memoName(attempt, 0, ModelReview.NAME),
			{
				models: api.pi.models,
				model,
				sessionId: Option.map(
					yield* api.snapshot(Run.Provider, api.conversationId),
					(provider) => provider.sessionId,
				),
				now: yield* api.now,
				instructions: Option.fromUndefinedOr(policy.instructions),
			},
			subject,
		);
		// The rule again, for the model that answered: behind a router alias a route of the author's family may
		// have served. Its findings are then no review, and no check of the product runs.
		const served = answeredBy(policy, author, reply);
		const asked = { ...about, reviewer: served.reviewer, call: reply.call };
		if (served._tag === "Unreviewable") return yield* unreviewed(api, asked, served.reason);
		// One after another: each report is a memo, which is a commit of its own. The attempt and the position are
		// part of the memo's name, so two checks of one name, and two attempts, never read each other's report.
		const others = yield* Effect.forEach(options.checks, (check, index) =>
			Effect.map(Report.once(api.memo, memoName(attempt, index + 1, check.name), check, subject), (report) => ({
				check: check.name,
				report,
			})),
		);
		const { verdict, step } = decided(options, asked, { task: api.taskId, attempt }, reply, others);
		return yield* conclude(api, verdict, step);
	});
}

/** The memo that keeps what the check `name`, at `position` among the checks, came to for the request `attempt`. */
function memoName(attempt: number, position: number, name: string): string {
	return `review.check/${attempt}/${position}/${name}`;
}

/** The answer a review task decides about, the run that led to it, and the run's count so far. */
interface Yielded {
	readonly answerId: EntryId;
	readonly message: AssistantMessage;
	/** The model messages of the run, oldest first, the answer last. */
	readonly transcript: ReadonlyArray<Message>;
	/** The number of this review within its run, from 1. */
	readonly pass: number;
	/** The corrective runs the run was sent on before this review. */
	readonly corrections: number;
}

/**
 * Reads what the task reviews: the answer Pi's live run names, and the run's entries from the input that started it
 * to that answer. The run's earlier verdicts are its count: a corrective run is counted in the commit that asked for
 * it, and a pass is counted per reviewed answer, so a review that was deferred and is asked again keeps its number.
 * A run Pi recorded no first entry for is read from the start of the conversation: it then counts every earlier
 * correction, and is held sooner, never later.
 */
function examined(api: Api) {
	return Effect.gen(function* () {
		const missing = new NoAnswerUnderReview({ conversationId: api.conversationId, taskId: api.taskId });
		const run = Run.view(yield* api.snapshot(Run.Live, api.conversationId));
		if (Option.isNone(run.yielded)) return yield* missing;
		const answerId = run.yielded.value;
		const entries = yield* Stream.runCollect(
			api.entries({
				order: "ascending",
				maxEntryId: answerId,
				...(Option.isSome(run.first) ? { minEntryId: run.first.value } : {}),
			}),
		);
		const message = entries.at(-1)?.model?.[0];
		if (message?.role !== "assistant") return yield* missing;
		const earlier = (yield* Effect.forEach(entries, (entry) => VerdictEntry.read(entry))).flatMap(Option.toArray);
		const yielded: Yielded = {
			answerId,
			message,
			transcript: entries.flatMap((entry) => entry.model ?? []),
			// Per answer: an earlier answer whose review was deferred and asked again has two verdicts and one pass.
			pass: new Set(earlier.map((verdict) => verdict.data.answer)).size + 1,
			corrections: earlier.filter((verdict) => verdict.data.outcome._tag === "Corrected").length,
		};
		return yielded;
	});
}

/** The model that wrote the answer: what the answer's own message names, not what the conversation runs with. */
function authorOf(yielded: Yielded): ModelRef {
	return { provider: yielded.message.provider, modelId: yielded.message.model };
}

/**
 * `author` paired with who answered the reviewer's request: the model the response names, or the policy's reviewer
 * for a request that got no answer.
 */
function answeredBy(policy: Policy, author: ModelRef, reply: ModelReview.Reply): Pairing {
	return reply._tag === "Unanswered"
		? pair(policy, author)
		: pair(policy, author, { provider: reply.call.provider, modelId: reply.call.model });
}

/** What every verdict of one review says, whatever its outcome. */
type About = Pick<Verdict, "answer" | "pass" | "corrections" | "author" | "reviewer" | "call">;

/** A verdict before the harness clock is read for it. */
type Undated = Omit<Verdict, "time">;

function aboutOf(yielded: Yielded, pairing: Pairing): About {
	return {
		answer: yielded.answerId,
		pass: yielded.pass,
		corrections: yielded.corrections,
		author: pairing.author,
		reviewer: pairing.reviewer,
	};
}

/**
 * The verdict of a review whose reviewer gave `reply` and whose other checks gave `others`, and the step the task
 * takes with it:
 *
 * - no blocking finding: the answer stands, as passed, or as not reviewed when a check failed. A check that failed
 *   found nothing, which is not the same as nothing to find. When the failure is the reviewer's request, nothing was
 *   said about the answer at all: the task sleeps until it is asked to review again.
 * - a blocking finding and a correction left: the run continues with the correction message, and the count grows.
 * - a blocking finding and none left: the task sleeps until a person's decision arrives.
 */
function decided<R>(
	options: Options<R>,
	about: About,
	turn: { readonly task: TaskId; readonly attempt: number },
	reply: ModelReview.Reply,
	others: ReadonlyArray<{ readonly check: string; readonly report: Report.Report }>,
): { readonly verdict: Undated; readonly step: Step } {
	const reports = [{ check: ModelReview.NAME, report: ModelReview.report(reply) }, ...others];
	const findings = reports.flatMap(({ check, report }) =>
		report._tag === "Found" ? report.findings.map((finding) => ({ check, ...finding })) : [],
	);
	const failures = reports.flatMap(({ check, report }) =>
		report._tag === "Failed" ? [{ check, error: report.error }] : [],
	);
	const reviewed = { ...about, findings, failures };
	const blocking = findings.filter((finding) => blocks(finding.severity, options.policy.blocking));
	if (blocking.length === 0) {
		if (failures.length === 0) return { verdict: { ...reviewed, outcome: { _tag: "Passed" } }, step: STANDS };
		if (reply._tag === "Unanswered") {
			return {
				verdict: { ...reviewed, outcome: { _tag: "Deferred", ...turn } },
				step: waitingToRetry(turn.attempt),
			};
		}
		return { verdict: { ...reviewed, outcome: { _tag: "NotReviewed", reason: "check_failed" } }, step: STANDS };
	}
	// Written so that a count that is no number leaves no correction: the run is then held, never corrected forever.
	if (!(about.corrections < options.policy.maxCorrections)) {
		return { verdict: { ...reviewed, outcome: { _tag: "Held", task: turn.task } }, step: waiting(about.answer) };
	}
	const message = Correction.write(options.correction, {
		pass: about.pass,
		blocking,
		remarks: findings.filter((finding) => !blocking.includes(finding)),
	});
	return {
		verdict: { ...reviewed, corrections: about.corrections + 1, outcome: { _tag: "Corrected" } },
		step: Task.complete(Hook.continueWith(message)),
	};
}

/** The step of a review that lets the run end with the answer. */
const STANDS: Step = Task.complete(Hook.stand);

/** The step of a held task: asleep, holding no process, until a decision about `answer` is delivered. */
function waiting(answer: EntryId): Step {
	return Task.sleep({ state: { phase: "held", answer }, signals: [Hold.Released.key(Hold.KEY)] });
}

/** The step of a deferred task: asleep, holding no process, until it is asked again after the request `attempt`. */
function waitingToRetry(attempt: number): Step {
	return Task.sleep({
		state: { phase: "deferred", attempt },
		signals: [Deferral.Retried.key(Deferral.key(attempt))],
	});
}

/** Ends a review that was not made: the verdict says why, and the run ends with the answer. */
function unreviewed(api: Api, about: About, reason: Unreviewed) {
	return conclude(api, { ...about, findings: [], failures: [], outcome: { _tag: "NotReviewed", reason } }, STANDS);
}

/** Stores the verdict, dated by the harness clock, and the task's step in one commit: together, or not at all. */
function conclude(api: Api, verdict: Undated, step: Step) {
	return Effect.flatMap(api.now, (time) =>
		api.commit((tx) => Effect.as(tx.append(VerdictEntry, api.conversationId, { data: { ...verdict, time } }), step)),
	);
}

/**
 * Runs when a held task wakes: reads the person's decision and ends the hold with it, the decision's entry and the
 * task's result in one commit. A task that woke without a decision sleeps again on the same key.
 */
function released(answer: EntryId, api: Api) {
	return Effect.gen(function* () {
		const state = yield* api.readSignal(Hold.Released, Hold.KEY);
		if (Option.isNone(state) || state.value.kind !== "value") return waiting(answer);
		const decision = state.value.value;
		const result = decision._tag === "Accept" ? Hook.stand : Hook.continueWith(decision.correction);
		const time = yield* api.now;
		return yield* api.commit((tx) =>
			Effect.as(
				tx.append(Hold.ReleaseEntry, api.conversationId, { data: { answer, decision, time } }),
				Task.complete(result),
			),
		);
	});
}

/**
 * Runs when a deferred task wakes: asked again, it reviews the same answer with the next request; woken without
 * being asked, it sleeps again on the same key.
 */
function retried(attempt: number, api: Api) {
	return Effect.map(
		api.readSignal(Deferral.Retried, Deferral.key(attempt)),
		(state): Step =>
			Option.isSome(state) && state.value.kind === "value"
				? Task.next({ phase: "review", attempt: attempt + 1 })
				: waitingToRetry(attempt),
	);
}

/**
 * Runs instead of the phases once Pi aborted the task. A review that ran, or waited to run again, leaves a verdict
 * that says it was aborted, in the commit that ends the task, so the answer does not read as one no review was asked
 * for. A held answer has its verdict already, and the state reads the ended hold from it.
 */
function aborted<R>(options: Options<R>, state: typeof State.Type, api: Api) {
	if (state.phase === "held") return Effect.succeed(Task.aborted());
	return Effect.gen(function* () {
		const yielded = yield* examined(api);
		const author = authorOf(yielded);
		// A reply the reviewer gave before the abort was paid for, so the verdict keeps its call. The failed request
		// of a deferred review is in that review's own verdict.
		const reply =
			state.phase === "review"
				? yield* ModelReview.kept(api.memo, memoName(state.attempt, 0, ModelReview.NAME))
				: Option.none();
		const about = Option.match(reply, {
			onNone: () => aboutOf(yielded, pair(options.policy, author)),
			onSome: (kept) => ({ ...aboutOf(yielded, answeredBy(options.policy, author, kept)), call: kept.call }),
		});
		return yield* conclude(
			api,
			{ ...about, findings: [], failures: [], outcome: { _tag: "NotReviewed", reason: "review_aborted" } },
			Task.aborted(),
		);
	}).pipe(
		// A failing abort handler faults the task. Without an answer to name, or with a commit Pi refuses, the task
		// ends aborted and stores nothing, as it did before it could say more.
		Effect.catch(() => Effect.succeed(Task.aborted())),
	);
}
