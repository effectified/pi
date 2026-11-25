// The model review: the policy's reviewer reads the task, the transcript of the run and the answer, and reports its
// findings as one JSON object. What its one request came to is kept in a memo of the review task.

import type { Api, AssistantMessage, Message, Model, Models } from "@earendil-works/pi-ai";
import type { DurableError } from "@gunta/pi-durable-effect";
import { Effect, Option, Schema } from "effect";
import type * as Check from "./check.ts";
import { describe, ReviewerRequestFailed, UndecodableReview } from "./errors.ts";
import { Finding } from "./finding.ts";
import * as Kept from "./kept.ts";
import type { Report } from "./report.ts";
import { Call } from "./verdict.ts";

/** The name the model review has as a check: on its findings and its failures. */
export const NAME = "review.model";

/** What the reviewer answers with, as a JSON object and nothing else. */
export const Findings = Schema.Struct({ findings: Schema.Array(Finding) });

/**
 * What one request to the reviewer came to, with the request as a product records it (`call`):
 *
 * - `Reviewed`: the reviewer answered with its findings.
 * - `Undecodable`: it answered, but not with the findings object. The answer under review was not judged.
 * - `Unanswered`: the request failed or was refused before an answer: nothing was said about the answer under
 *   review, so the same review can be asked again later.
 */
export const Reply = Schema.Union([
	Schema.TaggedStruct("Reviewed", { call: Call, findings: Schema.Array(Finding) }),
	Schema.TaggedStruct("Undecodable", { call: Call, error: Schema.String }),
	Schema.TaggedStruct("Unanswered", { call: Call, error: Schema.String }),
]);

/** What one request to the reviewer came to. */
export type Reply = typeof Reply.Type;

/** What one request to the reviewer is made with. */
export interface Request {
	/** The harness's models (a task's `api.pi.models`): what wraps them, such as a budget, sees the request. */
	readonly models: Models;
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
export function ask(request: Request, subject: Check.Subject): Effect.Effect<Reply> {
	const reviewer = { provider: request.model.provider, modelId: request.model.id };
	const unanswered = (call: Call, reason: string): Reply => ({
		_tag: "Unanswered",
		call,
		error: new ReviewerRequestFailed({ ...reviewer, reason }).message,
	});
	return Effect.tryPromise({
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
	}).pipe(
		Effect.flatMap((reply): Effect.Effect<Reply> => {
			const call = callOf(reply);
			// pi-ai resolves with an error message for a request that failed or was aborted.
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				return Effect.succeed(unanswered(call, reply.errorMessage ?? reply.stopReason));
			}
			return decode(unfenced(textOf(reply))).pipe(
				Effect.map((answered): Reply => ({ _tag: "Reviewed", call, findings: answered.findings })),
				Effect.catch((error) =>
					Effect.succeed<Reply>({
						_tag: "Undecodable",
						call,
						error: new UndecodableReview({ ...reviewer, reason: error.message }).message,
					}),
				),
			);
		}),
		// No response at all: the call is the request as it was sent, with what it was rejected with.
		Effect.catch((reason) =>
			Effect.succeed(
				unanswered(
					{
						provider: reviewer.provider,
						model: reviewer.modelId,
						api: request.model.api,
						stopReason: "error",
						timestamp: request.now,
						error: reason,
					},
					reason,
				),
			),
		),
	);
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
	return reply._tag === "Reviewed"
		? { _tag: "Found", findings: reply.findings }
		: { _tag: "Failed", error: reply.error };
}

/**
 * A response as a product records a model call: who answered, through which api, how it ended, when and for how
 * long, and what it used and cost. pi-ai's optional fields stay absent when the response has none.
 */
function callOf(reply: AssistantMessage): Call {
	const { usage } = reply;
	return {
		provider: reply.provider,
		model: reply.model,
		api: reply.api,
		...(reply.responseModel === undefined ? {} : { responseModel: reply.responseModel }),
		...(reply.responseId === undefined ? {} : { responseId: reply.responseId }),
		stopReason: reply.stopReason,
		timestamp: reply.timestamp,
		...(reply.durationMs === undefined ? {} : { durationMs: reply.durationMs }),
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
			...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
			totalTokens: usage.totalTokens,
			cost: usage.cost.total,
			costs: {
				input: usage.cost.input,
				output: usage.cost.output,
				cacheRead: usage.cost.cacheRead,
				cacheWrite: usage.cost.cacheWrite,
				total: usage.cost.total,
				...(usage.cost.totalFromProvider === undefined ? {} : { totalFromProvider: usage.cost.totalFromProvider }),
			},
		},
		...(reply.errorMessage === undefined ? {} : { error: reply.errorMessage }),
	};
}

/** The text of an assistant message: its text parts, joined. */
export function textOf(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const INSTRUCTIONS = [
	"You review the final answer another model gave to a task. You are given the task, the transcript of the run and the answer.",
	"Report every problem of the answer as a finding. Judge the answer, not the run that led to it.",
	'Answer with one JSON object and nothing else: {"findings":[{"severity":"block","text":"...","location":"..."}]}',
	'"severity" is "block" for a problem that makes the answer wrong or unsafe to rely on, "warn" for one that should be fixed, and "info" for a remark.',
	'"text" says what is wrong and what a correct answer needs. "location" is optional: the part of the answer the finding is about, quoted.',
	'An answer without problems gets {"findings":[]}.',
].join("\n");

function instructions(added: Option.Option<string>): string {
	return Option.isSome(added) ? `${INSTRUCTIONS}\n\n${added.value}` : INSTRUCTIONS;
}

/** The one message the reviewer gets: the task, the run, and the answer under review. */
function question(subject: Check.Subject): string {
	const task = subject.transcript.find((message) => message.role === "user");
	return [
		...(task === undefined ? [] : [`# Task\n\n${rendered(task)}`]),
		`# Transcript of the run\n\n${subject.transcript.flatMap(line).join("\n\n")}`,
		`# Answer under review\n\n${subject.answer}`,
	].join("\n\n");
}

/** One message of the transcript as the reviewer reads it; nothing for a system message, which is no part of the run. */
function line(message: Message): ReadonlyArray<string> {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [`User: ${rendered(message)}`];
		case "assistant":
			return [`Assistant: ${rendered(message)}`];
		case "toolResult":
			return [`Tool ${message.toolName}${message.isError ? " (error)" : ""}: ${rendered(message)}`];
	}
}

/** The content of a message as text: its text parts, its tool calls with their arguments, a mark for an image. */
function rendered(message: Exclude<Message, { readonly role: "system" }>): string {
	return typeof message.content === "string" ? message.content : message.content.flatMap(part).join("\n");
}

type Part = Exclude<Exclude<Message, { readonly role: "system" }>["content"], string>[number];

/** One part of a message's content as the reviewer reads it; nothing for the author's thinking. */
function part(content: Part): ReadonlyArray<string> {
	switch (content.type) {
		case "text":
			return [content.text];
		case "toolCall":
			return [`[calls ${content.name} with ${JSON.stringify(content.arguments)}]`];
		case "image":
			return ["[image]"];
		case "thinking":
			return [];
	}
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Findings));

const decodeReply = Schema.decodeUnknownEffect(Reply);

/** `text` without the Markdown code fence models often put around JSON. */
function unfenced(text: string): string {
	const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text.trim());
	return fenced?.[1] ?? text.trim();
}
