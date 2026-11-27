// The model review: the policy's reviewer reads the task, the transcript of the run and the answer, and reports its
// findings as one JSON object. What its one request came to is kept in a memo of the review task.

import type { Api, AssistantMessage, Message, Model, PiModels } from "@effectified/pi-ai";
import { ANSWERED, ModelId, modelRefOf, ProviderId, reported } from "@effectified/pi-ai";
import type { DurableError } from "@effectified/pi-durable";
import { Array as Arr, Effect, Formatter, Match, Option, Result, Schema, String as Str } from "effect";
import * as Check from "./check.ts";
import { describe, ReviewerRequestFailed, UndecodableReview } from "./errors.ts";
import { Finding } from "./finding.ts";
import * as Kept from "./kept.ts";
import type { ModelRef } from "./policy.ts";
import { Report } from "./report.ts";
import { Call } from "./verdict.ts";

/** The name the model review has as a check: on its findings and its failures. */
export const NAME = Check.Name.make("review.model");

/** What the reviewer answers with, as a JSON object and nothing else. */
export const Findings = Schema.Struct({ findings: Schema.Array(Finding) });

/**
 * What one request to the reviewer came to, with the request as a product records it (`call`). `Reply.match` picks a
 * handler per tag:
 *
 * - `Reviewed`: the reviewer answered with its findings.
 * - `Undecodable`: it answered, but not with the findings object. The answer under review was not judged.
 * - `Unanswered`: the request failed or was refused before an answer: nothing was said about the answer under
 *   review, so the same review can be asked again later.
 */
export const Reply = Schema.TaggedUnion({
	Reviewed: { call: Call, findings: Schema.Array(Finding) },
	Undecodable: { call: Call, error: Schema.String },
	Unanswered: { call: Call, error: Schema.String },
});

/** What one request to the reviewer came to. */
export type Reply = typeof Reply.Type;

/**
 * What one request to the reviewer is made with. An interface, not a Schema: it holds pi-ai's models and model, which
 * are services and functions, not data.
 */
export interface Request {
	/** The harness's models (a task's `api.pi.models`): what wraps them, such as a budget, sees the request. */
	readonly models: PiModels;
	/** The reviewer, resolved from those models. */
	readonly model: Model<Api>;
	/** The reviewed conversation's provider session, sent as pi-ai's `sessionId`: a cap per conversation counts it. */
	readonly sessionId: Option.Option<string>;
	/** The harness clock, in epoch milliseconds: the timestamp of the request's message. */
	readonly now: number;
	/** The policy's `instructions`. */
	readonly instructions: Option.Option<string>;
}

/**
 * Asks the reviewer about `subject`: one request, without tools. It never fails: a request the provider failed,
 * refused or threw for is `Unanswered` with the provider's own error text in `call.error`, and an answer that is not
 * the findings object is `Undecodable`. An interruption, Pi aborting the task or closing, stays one.
 */
export const ask: (request: Request, subject: Check.Subject) => Effect.Effect<Reply> = Effect.fn("ModelReview.ask")(
	function* (request: Request, subject: Check.Subject) {
		const reviewer = modelRefOf(request.model);
		const response = yield* Effect.result(
			Effect.tryPromise({
				try: (signal) =>
					request.models.completeSimple(
						request.model,
						{
							systemPrompt: instructions(request.instructions),
							messages: [{ role: "user", content: question(subject), timestamp: request.now }],
						},
						{ signal, ...(Option.isSome(request.sessionId) ? { sessionId: request.sessionId.value } : {}) },
					),
				catch: describe,
			}),
		);
		if (Result.isFailure(response)) {
			// No response at all: the call is the request as it was sent, with what it was rejected with.
			const call = Call.make({
				provider: reviewer.provider,
				model: reviewer.modelId,
				api: request.model.api,
				stopReason: "error",
				timestamp: request.now,
				error: response.failure,
			});
			return unanswered(reviewer, call, response.failure);
		}
		const reply = response.success;
		const call = callOf(reply);
		// pi-ai resolves a request that gave no answer with its message too: one that failed or was aborted, or a
		// response still pending or deferred, which Pi Durable does not take as an answer either.
		if (!ANSWERED[reply.stopReason]) return unanswered(reviewer, call, reply.errorMessage ?? reply.stopReason);
		return yield* Effect.match(decode(unfenced(textOf(reply))), {
			onSuccess: ({ findings }): Reply => Reply.cases.Reviewed.make({ call, findings }),
			onFailure: (error): Reply =>
				Reply.cases.Undecodable.make({
					call,
					error: UndecodableReview.make({ ...reviewer, reason: error.message }).message,
				}),
		});
	},
);

/** The reply of a request that got no answer from `reviewer`: `call` as it was recorded, and why. */
function unanswered(reviewer: ModelRef, call: Call, reason: string): Reply {
	return Reply.cases.Unanswered.make({ call, error: ReviewerRequestFailed.make({ ...reviewer, reason }).message });
}

/**
 * `ask`, once per memo `name` of the review task: a reply the memo holds is returned as it is, so a phase that runs
 * again after a close or a crash sends no second request. A failed request is kept too: asking again is a new
 * attempt of the task, under another name.
 */
export function once(
	memos: Kept.Memos,
	name: string,
	request: Request,
	subject: Check.Subject,
): Effect.Effect<Reply, DurableError> {
	return Kept.once(memos, name, decodeReply, ask(request, subject));
}

/** The reply the memo `name` holds: none while the reviewer has not answered under that name. */
export function kept(memos: Kept.Memos, name: string): Effect.Effect<Option.Option<Reply>, DurableError> {
	return Kept.read(memos, name, decodeReply);
}

/** A reply as the report of the check `NAME`: its findings, or the failure it ended with instead. */
export function report(reply: Reply): Report {
	return Reply.match(reply, {
		Reviewed: ({ findings }) => Report.cases.Found.make({ findings }),
		Undecodable: ({ error }) => Report.cases.Failed.make({ error }),
		Unanswered: ({ error }) => Report.cases.Failed.make({ error }),
	});
}

/**
 * What the record of the reviewer's request takes of each field of pi-ai's response. Its content is the reply, read
 * into findings; not recorded: the thinking levels asked for and used, pi-ai's diagnostics of the response, a
 * deferred response's handle, the provider's own stop reason and whether the model said its turn ended. A field
 * pi-ai adds fails to compile here until it is decided.
 */
const CALL = {
	role: "excluded",
	content: "excluded",
	api: "recorded",
	provider: "recorded",
	model: "recorded",
	responseModel: "recorded",
	responseId: "recorded",
	stopReason: "recorded",
	errorMessage: "recorded",
	usage: "recorded",
	timestamp: "recorded",
	durationMs: "recorded",
	thinkingLevel: "excluded",
	providerThinkingLevel: "excluded",
	diagnostics: "excluded",
	deferred: "excluded",
	rawStopReason: "excluded",
	endTurn: "excluded",
} as const satisfies Record<keyof AssistantMessage, "recorded" | "excluded">;

/** The fields of a response the record of a call takes. */
type Recorded = { [K in keyof typeof CALL]: (typeof CALL)[K] extends "recorded" ? K : never }[keyof typeof CALL];

/**
 * A response as a product records a model call: who answered, through which api, how it ended, when and for how
 * long, and what it used and cost. pi-ai's optional fields stay absent when the response has none. The provider and
 * model it names are pi-ai's plain strings, branded here where they enter.
 */
function callOf(reply: Pick<AssistantMessage, Recorded>): Call {
	const { usage } = reply;
	return Call.make({
		provider: ProviderId.make(reply.provider),
		model: ModelId.make(reply.model),
		api: reply.api,
		...(reply.responseModel === undefined ? {} : { responseModel: reply.responseModel }),
		...(reply.responseId === undefined ? {} : { responseId: reply.responseId }),
		stopReason: reply.stopReason,
		timestamp: reported(reply.timestamp),
		...(reply.durationMs === undefined ? {} : { durationMs: reported(reply.durationMs) }),
		usage: {
			input: reported(usage.input),
			output: reported(usage.output),
			cacheRead: reported(usage.cacheRead),
			cacheWrite: reported(usage.cacheWrite),
			...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: reported(usage.cacheWrite1h) }),
			...(usage.reasoning === undefined ? {} : { reasoning: reported(usage.reasoning) }),
			totalTokens: reported(usage.totalTokens),
			cost: reported(usage.cost.total),
			costs: {
				input: reported(usage.cost.input),
				output: reported(usage.cost.output),
				cacheRead: reported(usage.cost.cacheRead),
				cacheWrite: reported(usage.cost.cacheWrite),
				total: reported(usage.cost.total),
				...(usage.cost.totalFromProvider === undefined ? {} : { totalFromProvider: usage.cost.totalFromProvider }),
			},
		},
		...(reply.errorMessage === undefined ? {} : { error: reply.errorMessage }),
	});
}

/** The text of an assistant message: its text parts, joined. */
export function textOf(message: AssistantMessage): string {
	return Arr.join(
		Arr.flatMap(message.content, (part) => (part.type === "text" ? [part.text] : [])),
		"",
	);
}

const INSTRUCTIONS = Arr.join(
	[
		"You review the final answer another model gave to a task. You are given the task, the transcript of the run and the answer.",
		"Report every problem of the answer as a finding. Judge the answer, not the run that led to it.",
		'Answer with one JSON object and nothing else: {"findings":[{"severity":"block","text":"...","location":"..."}]}',
		'"severity" is "block" for a problem that makes the answer wrong or unsafe to rely on, "warn" for one that should be fixed, and "info" for a remark.',
		'"text" says what is wrong and what a correct answer needs. "location" is optional: the part of the answer the finding is about, quoted.',
		'An answer without problems gets {"findings":[]}.',
	],
	"\n",
);

/** The reviewer's system prompt: this package's instructions, then the policy's. */
function instructions(added: Option.Option<string>): string {
	return Option.isSome(added) ? `${INSTRUCTIONS}\n\n${added.value}` : INSTRUCTIONS;
}

/** The one message the reviewer gets: the task, the run, and the answer under review. */
function question(subject: Check.Subject): string {
	const task = Arr.findFirst(subject.transcript, (message) => message.role === "user");
	return Arr.join(
		[
			...Option.toArray(Option.map(task, (message) => `# Task\n\n${rendered(message)}`)),
			`# Transcript of the run\n\n${Arr.join(Arr.flatMap(subject.transcript, line), "\n\n")}`,
			`# Answer under review\n\n${subject.answer}`,
		],
		"\n\n",
	);
}

/** One message of the transcript as the reviewer reads it; nothing for a system message, which is no part of the run. */
const line: (message: Message) => ReadonlyArray<string> = Match.type<Message>().pipe(
	Match.discriminatorsExhaustive("role")({
		system: () => [],
		user: (message) => [`User: ${rendered(message)}`],
		assistant: (message) => [`Assistant: ${rendered(message)}`],
		toolResult: (message) => [`Tool ${message.toolName}${message.isError ? " (error)" : ""}: ${rendered(message)}`],
	}),
);

/** A message of the run: any but a system message. */
type RunMessage = Exclude<Message, { readonly role: "system" }>;

/** The content of a message as text: its text parts, its tool calls with their arguments, a mark for an image. */
function rendered(message: RunMessage): string {
	return typeof message.content === "string" ? message.content : Arr.join(Arr.flatMap(message.content, part), "\n");
}

/** One part of a message's content. */
type Part = Exclude<RunMessage["content"], string>[number];

/** One part of a message's content as the reviewer reads it; nothing for the author's thinking. */
const part: (content: Part) => ReadonlyArray<string> = Match.type<Part>().pipe(
	Match.discriminatorsExhaustive("type")({
		text: (content) => [content.text],
		toolCall: (content) => [`[calls ${content.name} with ${Formatter.formatJson(content.arguments)}]`],
		image: () => ["[image]"],
		thinking: () => [],
	}),
);

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Findings));

const decodeReply = Schema.decodeUnknownEffect(Reply);

/** `text` without the Markdown code fence models often put around JSON. */
function unfenced(text: string): string {
	const trimmed = Str.trim(text);
	const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return fenced?.[1] ?? trimmed;
}
