import { type AssistantMessage, createModels, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { runTest } from "@effectified/pi-ai/testing";
import {
	answer,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
} from "@effectified/pi-durable/testing";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type Check, state } from "../src/index.ts";
import { ask, kept, NAME, once, report, textOf } from "../src/model-review.ts";
import { ask as asking, CALL, live, PARTIES, REVIEWED, reached, scene } from "./scene.ts";

/** Asks once, with the reviewer answering `reply`, and reads the state the run ended in and what was asked. */
function reviewedWith(reply: FauxResponseStep) {
	const given = scene({ author: [answer("It is 42.")], reviewer: [reply] });
	return Effect.runPromise(
		Effect.gen(function* () {
			const { root, submission } = yield* asking();
			const settled = yield* submission.wait;
			yield* root.waitForIdle;
			return {
				status: settled.status,
				state: yield* state(root),
				requests: [given.authorRequests.length, given.reviewer.state.callCount],
			};
		}).pipe(Effect.provide(given.layer)),
	);
}

describe("the model review", () => {
	it("decodes the findings object, also inside a Markdown code fence", async () => {
		const fenced = '```json\n{"findings":[{"severity":"info","text":"Fine."}]}\n```';
		const result = await reviewedWith(answer(fenced));
		expect(result.state).toMatchObject({
			_tag: "Reviewed",
			verdict: { findings: [{ check: NAME, severity: "info", text: "Fine." }], failures: [] },
		});
	});

	it("reads the reviewer's text and not its thinking", async () => {
		const thought = fauxAssistantMessage([
			fauxThinking('{"findings":[{"severity":"block","text":"No."}]}'),
			fauxText('{"findings":[]}'),
		]);
		expect((await reviewedWith(thought)).state).toMatchObject({ _tag: "Reviewed", verdict: { findings: [] } });
	});

	it("records an answer that is not the findings object as not reviewed, and sends nothing back", async () => {
		const result = await reviewedWith(answer("Looks fine to me."));
		expect(result.state).toEqual({
			_tag: "NotReviewed",
			reason: "check_failed",
			verdict: {
				...REVIEWED,
				pass: 1,
				corrections: 0,
				findings: [],
				failures: [
					{
						check: "review.model",
						error: expect.stringMatching(
							/^The answer of the reviewer reviewer-lab\/judge is not a list of findings: /,
						),
					},
				],
				outcome: { _tag: "NotReviewed", reason: "check_failed" },
			},
		});
		// The run ended with the answer, after one request to each model: no correction was asked for.
		expect([result.status, result.requests]).toEqual(["done", [1, 1]]);
	});

	it("defers the review of a reviewer whose response is deferred: Pi Durable takes it as no answer", async () => {
		// The findings object, in a response the provider has not finished: no review of the answer passed.
		const deferred = fauxAssistantMessage('{"findings":[]}', { stopReason: "deferred" });
		const given = scene({ author: [answer("It is 42.")], reviewer: [deferred] });
		const deferral = await runTest(
			Effect.gen(function* () {
				const { root } = yield* asking();
				// Whichever comes first: a deferral, or the review the response would be if it were an answer.
				return yield* Effect.raceFirst(reached(root, "Deferred"), reached(root, "Reviewed"));
			}).pipe(Effect.provide(given.layer)),
		);
		expect(deferral).toMatchObject({
			_tag: "Deferred",
			attempt: 1,
			// A deferred response has no error text of its own: the reason is the failure of the check.
			reason: "The reviewer reviewer-lab/judge did not answer: deferred",
			verdict: { findings: [], outcome: { _tag: "Deferred", attempt: 1 } },
		});
	});

	it("records JSON of another shape, and a severity it does not know, as not reviewed", async () => {
		const shapes = ['{"approved":true}', '{"findings":[{"severity":"fatal","text":"No."}]}', '{"findings":"none"}'];
		for (const shape of shapes) {
			expect((await reviewedWith(answer(shape))).state).toMatchObject({
				_tag: "NotReviewed",
				reason: "check_failed",
				verdict: { failures: [{ check: "review.model" }] },
			});
		}
	});
});

describe("ask", () => {
	const SUBJECT = {
		conversationId: 1,
		answerId: 2,
		answer: "It is 42.",
		author: PARTIES.author,
		pass: 1,
		transcript: [{ role: "user", content: "What is six times seven?", timestamp: 1 }],
		// Pi brands ids in the type system only: at run time they are the numbers.
	} as unknown as Check.Subject;

	/** Asks a scripted reviewer that answers with `step`; `models` is pi-ai's own collection. */
	function asked(step: FauxResponseStep) {
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		reviewer.setResponses(live([step]));
		const models = createModels();
		models.setProvider(reviewer.provider);
		return Effect.runPromise(
			ask(
				{ models, model: reviewer.getModel(), sessionId: Option.none(), now: 1, instructions: Option.none() },
				SUBJECT,
			),
		);
	}

	it("gives the findings with the request as a product records it", async () => {
		const reply = await asked(answer('{"findings":[{"severity":"warn","text":"Show the multiplication."}]}'));
		expect(reply).toEqual({
			_tag: "Reviewed",
			call: CALL,
			findings: [{ severity: "warn", text: "Show the multiplication." }],
		});
		expect(report(reply)).toEqual({ _tag: "Found", findings: reply._tag === "Reviewed" ? reply.findings : [] });
	});

	it("tells an answer that is not the findings object from a request that failed", async () => {
		const undecodable = await asked(answer("Looks fine to me."));
		const failed = await asked(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }));
		expect(undecodable).toEqual({
			_tag: "Undecodable",
			call: CALL,
			error: expect.stringMatching(/^The answer of the reviewer reviewer-lab\/judge is not a list of findings: /),
		});
		expect(failed).toEqual({
			_tag: "Unanswered",
			call: { ...CALL, stopReason: "error", error: "overloaded" },
			error: "The reviewer reviewer-lab/judge did not answer: overloaded",
		});
		expect([report(undecodable)._tag, report(failed)]).toEqual([
			"Failed",
			{ _tag: "Failed", error: "The reviewer reviewer-lab/judge did not answer: overloaded" },
		]);
	});

	it("gives a response that is deferred or still pending as unanswered, whatever its text", async () => {
		const deferred = await asked(fauxAssistantMessage('{"findings":[]}', { stopReason: "deferred" }));
		expect(deferred).toMatchObject({
			_tag: "Unanswered",
			call: { stopReason: "deferred" },
			error: "The reviewer reviewer-lab/judge did not answer: deferred",
		});
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		const partial: AssistantMessage = { ...fauxAssistantMessage('{"findings":[]}'), stopReason: "pending" };
		// Stands for models that resolve with a response that never ended: only the one call matters.
		const pending = { completeSimple: () => Promise.resolve(partial) } as unknown as Models;
		const request = { models: pending, model: reviewer.getModel(), sessionId: Option.none(), now: 1 };
		expect(await runTest(ask({ ...request, instructions: Option.none() }, SUBJECT))).toMatchObject({
			_tag: "Unanswered",
			call: { stopReason: "pending" },
			error: "The reviewer reviewer-lab/judge did not answer: pending",
		});
	});

	it("gives a request the provider threw for as unanswered, with the provider's text", async () => {
		const reply = await asked(() => {
			throw new Error("socket closed");
		});
		expect(reply).toMatchObject({
			_tag: "Unanswered",
			call: { provider: "reviewer-lab", model: "judge", stopReason: "error", error: "socket closed" },
		});
	});

	it("gives a request that was rejected without a response as unanswered: the call is the request, without usage", async () => {
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		// Stands for models that reject a request instead of answering with an error message: only the one call matters.
		const rejecting = { completeSimple: () => Promise.reject(new Error("no route")) } as unknown as Models;
		const reply = await Effect.runPromise(
			ask(
				{
					models: rejecting,
					model: reviewer.getModel(),
					sessionId: Option.none(),
					now: 1,
					instructions: Option.none(),
				},
				SUBJECT,
			),
		);
		// The api is the reviewer model's, and the time the one the request was sent at: no response says otherwise.
		expect(reply).toEqual({
			_tag: "Unanswered",
			call: {
				provider: "reviewer-lab",
				model: "judge",
				api: reviewer.getModel().api,
				stopReason: "error",
				timestamp: 1,
				error: "no route",
			},
			error: "The reviewer reviewer-lab/judge did not answer: no route",
		});
	});

	it("keeps of a response its api, the provider's ids, its times, and pi-ai's whole usage and cost", async () => {
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		// A response as a provider with every field reports it: a billed total, the cache and reasoning splits.
		const response: AssistantMessage = {
			...fauxAssistantMessage('{"findings":[]}'),
			api: "anthropic-messages",
			provider: "reviewer-lab",
			model: "judge",
			responseModel: "judge-2026-10-01",
			responseId: "msg_7",
			timestamp: 1_700_000_000_000,
			durationMs: 1_200,
			usage: {
				input: 120,
				output: 9,
				cacheRead: 30,
				cacheWrite: 4,
				cacheWrite1h: 4,
				reasoning: 3,
				totalTokens: 163,
				cost: {
					input: 0.0024,
					output: 0.0009,
					cacheRead: 0.0003,
					cacheWrite: 0.0006,
					total: 0.005,
					totalFromProvider: true,
				},
			},
		};
		// Stands for a provider whose responses carry every field: only the one call matters.
		const answering = { completeSimple: () => Promise.resolve(response) } as unknown as Models;
		const reply = await Effect.runPromise(
			ask(
				{
					models: answering,
					model: reviewer.getModel(),
					sessionId: Option.none(),
					now: 1,
					instructions: Option.none(),
				},
				SUBJECT,
			),
		);
		expect(reply).toEqual({
			_tag: "Reviewed",
			call: {
				provider: "reviewer-lab",
				model: "judge",
				api: "anthropic-messages",
				responseModel: "judge-2026-10-01",
				responseId: "msg_7",
				stopReason: "stop",
				timestamp: 1_700_000_000_000,
				durationMs: 1_200,
				usage: {
					input: 120,
					output: 9,
					cacheRead: 30,
					cacheWrite: 4,
					cacheWrite1h: 4,
					reasoning: 3,
					totalTokens: 163,
					cost: 0.005,
					costs: {
						input: 0.0024,
						output: 0.0009,
						cacheRead: 0.0003,
						cacheWrite: 0.0006,
						total: 0.005,
						totalFromProvider: true,
					},
				},
			},
			findings: [],
		});
	});
});

describe("once and kept", () => {
	it("ask the reviewer once per memo name, and read the kept reply back", async () => {
		const stored = new Map<string, unknown>();
		const memo = (name: string, candidate?: unknown) =>
			Effect.sync(() => {
				if (candidate === undefined) return Option.fromUndefinedOr(stored.get(name));
				if (!stored.has(name)) stored.set(name, candidate);
				return stored.get(name);
			});
		// The fake has the two call forms of Pi's memo in one signature, which its overloads cannot be checked against.
		const memos = memo as unknown as Parameters<typeof once>[0];
		const reviewer = fauxProvider({ provider: "reviewer-lab", models: [{ id: "judge" }] });
		reviewer.setResponses(live([answer('{"findings":[]}'), answer('{"findings":[]}')]));
		const models = createModels();
		models.setProvider(reviewer.provider);
		const request = {
			models,
			model: reviewer.getModel(),
			sessionId: Option.none<string>(),
			now: 1,
			instructions: Option.none<string>(),
		};
		const subject = { answer: "It is 42.", pass: 1, transcript: [] } as unknown as Check.Subject;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const before = yield* kept(memos, "review.check/1/0/review.model");
				const first = yield* once(memos, "review.check/1/0/review.model", request, subject);
				const again = yield* once(memos, "review.check/1/0/review.model", request, subject);
				const read = yield* kept(memos, "review.check/1/0/review.model");
				const next = yield* once(memos, "review.check/2/0/review.model", request, subject);
				return { before, first, again, read, next };
			}),
		);
		expect(result.before).toEqual(Option.none());
		expect(result.first).toEqual({ _tag: "Reviewed", call: CALL, findings: [] });
		expect([result.again, result.read]).toEqual([result.first, Option.some(result.first)]);
		// Another attempt is another name: a new request.
		expect(result.next._tag).toBe("Reviewed");
		expect(reviewer.state.callCount).toBe(2);
	});
});

describe("textOf", () => {
	it("joins the text parts of an assistant message", () => {
		expect(textOf(fauxAssistantMessage([fauxText("It is "), fauxThinking("six sevens"), fauxText("42.")]))).toBe(
			"It is 42.",
		);
	});
});
