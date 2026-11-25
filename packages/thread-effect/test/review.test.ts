// The review in the composition: one corrective run, a hold, the reviewer check before a thread starts and what the
// review plugin does without it, a review that could not be asked for, a thread that asks for none, and what of all
// that reaches the sink.

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { LeaseFenced } from "@gunta/pi-budget-effect";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, held } from "@gunta/pi-durable-effect/testing";
import * as Review from "@gunta/pi-review-effect";
import { Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ReviewerSharesFamily, Thread, ThreadNotFound, Threads } from "../src/index.ts";
import {
	BACKUP,
	committed,
	conflicts,
	expectedCost,
	JUDGE,
	outside,
	providers,
	REVIEW_POLICY,
	ROUTES,
	reservations,
	routed,
	run,
	SAME_FAMILY_REVIEWER,
	shape,
	UNCHECKED,
	WRITER,
	work,
} from "./world.ts";

const BLOCKING = answer('{"findings":[{"severity":"block","text":"Six times seven is 42.","location":"It is 41."}]}');
const CLEAN = answer('{"findings":[]}');

/** `ROUTES` with the author's own model as the second route of the reviewer's alias. */
const FALLING_BACK = (() => {
	const [author, reviewer, clone] = ROUTES.aliases;
	return { ...ROUTES, aliases: [author, { ...reviewer, routes: [...reviewer.routes, ...clone.routes] }, clone] };
})();

/** The records of entries without a model message, each id once, in delivery order. */
const entryRecords = (state: Parameters<typeof committed>[0]) =>
	committed(state).flatMap((record) => (record._tag === "Entry" ? [record] : []));

describe("the review of a thread's answer", () => {
	it("sends a blocking finding back for exactly one corrective run, then lets a clean answer stand", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 41."), answer("It is 42.")], reviewer: [BLOCKING, CLEAN] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "What is six times seven?"));
				const verdicts = yield* Stream.runCollect(Review.verdicts(yield* threads.conversation("t1")));
				return { outcome, verdicts: verdicts.map((entry) => [entry.data.pass, entry.data.outcome._tag]) };
			}),
		);
		expect(result.verdicts).toEqual([
			[1, "Corrected"],
			[2, "Passed"],
		]);
		expect(result.outcome).toMatchObject({
			_tag: "Reviewed",
			accepted: false,
			counts: { turns: 2, toolCalls: 0, refusedToolCalls: 0 },
			verdict: { pass: 2, corrections: 1, outcome: { _tag: "Passed" } },
		});
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 2]);
		// Four provider requests, four reservations, each settled once.
		expect(reservations(state).map(({ request, settlements }) => [request.model, settlements.length])).toEqual([
			["author", 1],
			["reviewer", 1],
			["author", 1],
			["reviewer", 1],
		]);
		// Each verdict follows the answer it is about, with the reviewer's request as a model call after it, and the
		// correction is a user message of the run.
		expect(committed(state).map(shape)).toEqual([
			{ _tag: "Message", role: "user", entryKind: "pi.user", text: "What is six times seven?" },
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
			{ _tag: "Message", role: "assistant", entryKind: "pi.assistant", text: "It is 41." },
			{ _tag: "Entry", kind: "review.verdict" },
			{ _tag: "ModelCall", provider: "reviewer-lab", model: "judge", stopReason: "stop", error: null },
			{
				_tag: "Message",
				role: "user",
				entryKind: "pi.user",
				text: expect.stringContaining("Six times seven is 42."),
			},
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
			{ _tag: "Message", role: "assistant", entryKind: "pi.assistant", text: "It is 42." },
			{ _tag: "Entry", kind: "review.verdict" },
			{ _tag: "ModelCall", provider: "reviewer-lab", model: "judge", stopReason: "stop", error: null },
		]);
	});

	it("holds the thread after two blocking verdicts, until a person accepts the answer", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 41."), answer("It is 40.")], reviewer: [BLOCKING, BLOCKING] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const held = yield* threads.work(work("t1", "What is six times seven?"));
				const probe = yield* threads.probe("t1");
				const accepted = yield* threads.release("t1", { _tag: "Accept", by: "user:ada" });
				const conversation = yield* threads.conversation("t1");
				const entries = yield* Stream.runCollect(conversation.entries({ order: "ascending" }));
				return {
					held,
					probe,
					accepted,
					after: yield* threads.probe("t1"),
					// A second decision finds no hold.
					again: yield* Effect.flip(threads.release("t1", { _tag: "Accept", by: "user:bob" })),
					conversation: conversation.id,
					releases: (yield* Effect.forEach(entries, Review.ReleaseEntry.read)).flatMap(Option.toArray),
				};
			}),
		);
		// One corrective run and no more: two answers, two reviews.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 2]);
		expect(result.held).toMatchObject({
			_tag: "Held",
			counts: { turns: 2, toolCalls: 0, refusedToolCalls: 0 },
			verdict: { pass: 2, corrections: 1, outcome: { _tag: "Held" }, findings: [{ severity: "block" }] },
		});
		// A held thread has unfinished work: its submission is not settled.
		expect(result.probe).toEqual({ alive: true });
		// `release` returns once the hold has ended: the outcome is the accepted answer's at once.
		expect(result.accepted).toMatchObject({
			_tag: "Reviewed",
			accepted: true,
			verdict: { outcome: { _tag: "Held" } },
		});
		expect(result.after).toEqual({ alive: false });
		expect(result.again).toBeInstanceOf(Review.NotHeld);
		// The person's decision reaches the sink as the record of its entry, after the two verdicts.
		const [stored] = result.releases;
		expect(result.releases).toHaveLength(1);
		expect(stored?.data).toEqual({
			answer: result.held._tag === "Held" ? result.held.verdict.answer : undefined,
			decision: { _tag: "Accept", by: "user:ada" },
			time: expect.any(Number),
		});
		expect(entryRecords(state).map((record) => record.kind)).toEqual([
			"review.verdict",
			"review.verdict",
			"review.release",
		]);
		expect(entryRecords(state)[2]).toEqual({
			_tag: "Entry",
			id: `${result.conversation}:${stored?.id}:entry`,
			conversation: result.conversation,
			entry: stored?.id,
			kind: "review.release",
			data: stored?.data,
			task: stored?.byTaskId,
			time: stored?.data.time,
			advisory: false,
		});
	});

	it("is not started with a reviewer of its author's family: the routes are named, and nothing is sent or reserved", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const refused = yield* Effect.flip(threads.work(work("t1", "What is six times seven?")));
				return {
					refused,
					probe: yield* threads.probe("t1"),
					outcome: yield* Effect.flip(threads.outcome("t1")),
					requests: [labs.author.state.callCount, labs.reviewer.state.callCount],
					// The check is about a review: a thread that asks for none starts with the same tables.
					unreviewed: yield* threads.work({ ...work("t2", "What is six times seven?"), review: false }),
				};
			}),
			{ review: { ...REVIEW_POLICY, reviewer: SAME_FAMILY_REVIEWER } },
		);
		// Every pair of a route that may write and a route that may review, of one family: the author's two labs
		// against the reviewer alias's one route, which is the author's own model.
		expect(result.refused).toEqual(
			new ReviewerSharesFamily({
				thread: "t1",
				conflicts: [
					{ family: "alpha", author: WRITER, reviewer: WRITER },
					{ family: "alpha", author: BACKUP, reviewer: WRITER },
				],
			}),
		);
		expect(result.refused.message).toContain("author-lab/writer reviews backup-lab/writer-b (alpha)");
		// No thread exists, and no provider and no lease was asked.
		expect(result.probe).toEqual({ alive: false });
		expect(result.outcome).toEqual(new ThreadNotFound({ thread: "t1" }));
		expect(result.requests).toEqual([0, 0]);
		expect(result.unreviewed).toMatchObject({ _tag: "Answered", counts: { turns: 1 } });
		expect(reservations(state).map(({ request }) => request.model)).toEqual(["author"]);
	});

	it("is not started when a route its reviewer's alias falls back to is of its author's family", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 41.")], reviewer: [CLEAN] });
		const refused = await run(
			state,
			labs,
			Effect.flip(Threads.Threads.use((threads) => threads.work(work("t1", "What is six times seven?")))),
			{ routes: FALLING_BACK },
		);
		// The reviewer alias is of family beta in the policy, and its first route is: the second one is not.
		expect(refused).toEqual(
			new ReviewerSharesFamily({
				thread: "t1",
				conflicts: [
					{ family: "alpha", author: WRITER, reviewer: WRITER },
					{ family: "alpha", author: BACKUP, reviewer: WRITER },
				],
			}),
		);
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([0, 0]);
		expect(state.lease.steps).toEqual([]);
	});

	it("without that check, pays a reviewer that fell back into the author's family for a review that judges nothing", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 41."), CLEAN],
			// No content: a response that had output is never taken over by another route.
			reviewer: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" })],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const outcome = yield* Threads.Threads.use((threads) =>
					threads.work(work("t1", "What is six times seven?")),
				);
				return { outcome, events: [...(yield* routed(state, 3))] };
			}),
			// What the review plugin does by itself, with a table the composition's check refuses.
			{ routes: FALLING_BACK, reviewers: UNCHECKED },
		);
		expect(result.events.map(({ alias, route, outcome }) => [alias, route.provider, outcome])).toEqual([
			["author", WRITER.provider, "served"],
			["reviewer", JUDGE.provider, "failed"],
			["reviewer", WRITER.provider, "served"],
		]);
		// The rule is applied again to the model the response names: the author's own model judged nothing. Its clean
		// answer is dropped, and the verdict names it as the reviewer it was.
		expect(result.outcome).toMatchObject({
			_tag: "NotReviewed",
			reason: "same_family",
			verdict: {
				author: { ...WRITER, family: "alpha" },
				reviewer: { ...WRITER, family: "alpha" },
				call: { provider: WRITER.provider, model: WRITER.modelId, stopReason: "stop" },
				findings: [],
				outcome: { _tag: "NotReviewed", reason: "same_family" },
			},
		});
		// The request that reviewed nothing was sent and paid for, and nothing asks again: the run has ended.
		const [, review] = reservations(state).filter(({ request }) => request.key === undefined);
		expect(review?.request.model).toBe("reviewer");
		expect((review?.settlements[0]?.cost ?? 0n) > 0n).toBe(true);
		expect(labs.author.state.callCount).toBe(2);
	});

	it("lets a person correct a held answer: the run goes on, and its next answer is reviewed", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 41."), answer("It is 40."), answer("It is 42.")],
			reviewer: [BLOCKING, BLOCKING, CLEAN],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const held = yield* threads.work(work("t1", "What is six times seven?"));
				const corrected = yield* threads.release("t1", {
					_tag: "Correct",
					by: "user:ada",
					correction: "Multiply again.",
				});
				return { held: held._tag, corrected };
			}),
		);
		expect(result.held).toBe("Held");
		expect(result.corrected).toMatchObject({
			_tag: "Reviewed",
			accepted: false,
			counts: { turns: 3 },
			verdict: { pass: 3, outcome: { _tag: "Passed" } },
		});
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([3, 3]);
	});

	it("is cancelled in the middle of a review: the review's own verdict says so, and the thread ends cancelled", async () => {
		const state = outside();
		const judging = held(CLEAN);
		const labs = providers({ author: [answer("It is 42.")], reviewer: [judging.response] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const working = yield* Effect.forkScoped(threads.work(work("t1", "What is six times seven?")));
				yield* judging.requested;
				yield* threads.cancel("t1");
				const outcome = yield* Fiber.join(working);
				const conversation = yield* threads.conversation("t1");
				const submission = yield* Harness.commit((tx) => Thread.newestIn(tx, conversation.id, "t1"));
				return {
					outcome,
					status: Option.getOrThrow(submission).record.status,
					state: yield* Review.state(conversation),
					// A cancelled thread stays cancelled: a resume neither continues nor reviews it.
					resumed: yield* threads.resume("t1"),
				};
			}),
		);
		// Pi settles the inputs of a run aborted under review `done`: the verdict the review stored as it was aborted
		// is what tells it from an answered run. The composition keeps no mark of its own.
		expect(result.status).toBe("done");
		expect(result.state).toMatchObject({
			_tag: "NotReviewed",
			reason: "review_aborted",
			verdict: { pass: 1, outcome: { _tag: "NotReviewed", reason: "review_aborted" } },
		});
		expect(result.outcome).toMatchObject({ _tag: "Cancelled", counts: { turns: 1 } });
		expect(result.resumed).toEqual(result.outcome);
		// The reviewer's request was aborted, and its reservation is settled.
		expect(reservations(state).map(({ settlements }) => settlements.map((settlement) => settlement.outcome))).toEqual(
			[["returned"], ["aborted"]],
		);
		expect(entryRecords(state).map((record) => record.kind)).toEqual(["review.verdict"]);
	});

	it("is cancelled while held: the hold ends without a decision", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 41."), answer("It is 40.")], reviewer: [BLOCKING, BLOCKING] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const held = yield* threads.work(work("t1", "What is six times seven?"));
				yield* threads.cancel("t1");
				return { held: held._tag, cancelled: yield* threads.resume("t1"), probe: yield* threads.probe("t1") };
			}),
		);
		expect(result.held).toBe("Held");
		expect(result.cancelled).toMatchObject({ _tag: "Cancelled", counts: { turns: 2 } });
		expect(result.probe).toEqual({ alive: false });
	});

	it("blocks an answer whose citation the product's verifier does not resolve", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 42 [missing]."), answer("It is 42 [atlas].")],
			reviewer: [CLEAN, CLEAN],
		});
		const outcome = await run(
			state,
			labs,
			Threads.Threads.use((threads) => threads.work(work("t1", "What is six times seven?"))),
		);
		expect(outcome).toMatchObject({ _tag: "Reviewed", verdict: { pass: 2, corrections: 1, findings: [] } });
	});
});

describe("what the sink is told of a review", () => {
	it("gets the verdict as the record of its entry, and the reviewer's request as a model call record after it", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], reviewer: [CLEAN] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				yield* threads.work(work("t1", "What is six times seven?"));
				const conversation = yield* threads.conversation("t1");
				return {
					conversation: conversation.id,
					verdicts: yield* Stream.runCollect(Review.verdicts(conversation)),
					usage: yield* Harness.usage,
				};
			}),
		);
		const [verdict] = result.verdicts;
		const [, review] = reservations(state);
		expect(reservations(state).map(({ request, settlements }) => [request.model, settlements[0]?.outcome])).toEqual([
			["author", "returned"],
			["reviewer", "returned"],
		]);
		// One record for the one verdict: the entry as it is stored, under the id of its entry, with its task and
		// the time the review decided.
		expect(entryRecords(state)).toEqual([
			{
				_tag: "Entry",
				id: `${result.conversation}:${verdict?.id}:entry`,
				conversation: result.conversation,
				entry: verdict?.id,
				kind: "review.verdict",
				data: verdict?.data,
				task: verdict?.byTaskId,
				time: verdict?.data.time,
				advisory: false,
			},
		]);
		// Its data is the verdict whole. The reviewer's request is in it as a product records a model call: the route
		// that served, how it ended, and the tokens the lease settled for it.
		expect(verdict?.data).toMatchObject({
			pass: 1,
			corrections: 0,
			author: { ...WRITER, family: "alpha" },
			reviewer: { ...JUDGE, family: "beta" },
			call: { provider: JUDGE.provider, model: JUDGE.modelId, stopReason: "stop" },
			findings: [],
			failures: [],
			outcome: { _tag: "Passed" },
		});
		const { input, output, cacheRead, cacheWrite } = verdict?.data.call?.usage ?? {};
		expect({ input, output, cacheRead, cacheWrite }).toEqual(review?.settlements[0]?.usage);
		expect((verdict?.data.call?.usage?.totalTokens ?? 0) > 0).toBe(true);
		// The request is the review task's own, not a generation: the recorder derives no `ModelCall` from it, and
		// Pi's usage ledger does not hold it. The composition's sink wrapper makes one of the verdict's record, in the
		// shape of every other model call: the verdict's entry and task, the route and its api, when the request
		// started and how long it took, the tokens the lease settled and pi-ai's whole cost of them, `null` where
		// pi-ai reported nothing, and no field the verdict does not hold.
		const call = verdict?.data.call;
		const usage = call?.usage;
		const calls = committed(state).flatMap((record) => (record._tag === "ModelCall" ? [record] : []));
		expect(calls.map(shape)).toEqual([
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
			{ _tag: "ModelCall", provider: "reviewer-lab", model: "judge", stopReason: "stop", error: null },
		]);
		expect(calls[0]?.derived).toBeUndefined();
		expect(calls[1]).toEqual({
			_tag: "ModelCall",
			id: `${result.conversation}:${verdict?.id}:0:model`,
			conversation: result.conversation,
			entry: verdict?.id,
			time: call?.timestamp,
			advisory: false,
			task: verdict?.byTaskId,
			provider: JUDGE.provider,
			model: JUDGE.modelId,
			api: call?.api,
			responseModel: null,
			responseId: null,
			stopReason: "stop",
			error: null,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				cacheWrite1h: null,
				reasoning: null,
				totalTokens: usage?.totalTokens,
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.cost, fromProvider: false },
			// pi-ai times a scripted response only when it was scripted in the millisecond its request started.
			durationMs: call?.durationMs ?? null,
			derived: { from: `${result.conversation}:${verdict?.id}:entry`, unknown: [] },
		});
		// The api is the reviewer's own, and the time is when its request started: before the verdict was decided.
		expect(calls[1]?.api).toBe("scripted-reviewer-lab");
		expect(calls[1]?.time).toBeLessThanOrEqual(verdict?.data.time ?? 0);
		// pi-ai's cost of the response, which is nothing for a scripted model without a catalog price, and not the
		// route's price: that one the lease was told.
		expect(calls[1]?.cost.total).toBe(0);
		expect(review?.settlements[0]?.cost).toBe(
			expectedCost(JUDGE, review?.settlements[0]?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);
		expect(review?.settlements[0]?.cost).toBeGreaterThan(0n);
		// In the batch of its verdict, right after it. Every id came once.
		const batch = state.delivered.find((records) => records.some((record) => record.id === calls[1]?.id));
		expect(batch?.map((record) => record.id).slice(-2)).toEqual([
			`${result.conversation}:${verdict?.id}:entry`,
			`${result.conversation}:${verdict?.id}:0:model`,
		]);
		expect(conflicts(state)).toEqual([]);
		expect(Object.keys(result.usage.models)).toEqual(["author-lab/writer"]);
	});
});

describe("a review that could not be asked for", () => {
	it("stops the thread with the lease's reason when the budget refuses the reviewer, and reviews under a new lease", async () => {
		const state = outside();
		const labs = providers({
			author: [
				// The product loses its lease while the author's request is out: the reviewer's finds it fenced.
				() => {
					state.lease.fenced = "expired";
					return answer("It is 42.");
				},
			],
			reviewer: [CLEAN],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				// The call returns: a deferred review ends the thread as far as it goes by itself.
				const stopped = yield* threads.work(work("t1", "What is six times seven?"));
				const paused = {
					probe: yield* threads.probe("t1"),
					stored: yield* threads.outcome("t1"),
					// A resume while the lease is still fenced asks again, is refused again, and stops again.
					again: yield* threads.resume("t1"),
					requests: labs.reviewer.state.callCount,
				};
				state.lease.fenced = undefined;
				const resumed = yield* threads.resume("t1");
				const verdicts = yield* Stream.runCollect(Review.verdicts(yield* threads.conversation("t1")));
				return {
					stopped,
					paused,
					resumed,
					verdicts: verdicts.map(({ data }) => [data.pass, data.outcome._tag, data.answer]),
					after: yield* threads.probe("t1"),
				};
			}),
		);
		// The budget-stopped outcome, with the lease's own reason and the answer's deferred verdict.
		expect(result.stopped).toMatchObject({
			_tag: "BudgetStopped",
			refusal: new LeaseFenced({ reason: "expired" }),
			counts: { turns: 1, toolCalls: 0, refusedToolCalls: 0 },
			review: {
				pass: 1,
				call: { stopReason: "error", error: expect.stringContaining("Budget: the lease is fenced") },
				failures: [{ check: "review.model" }],
				outcome: { _tag: "Deferred", attempt: 1 },
			},
		});
		// The answer is there and its submission is open: the thread has unfinished work.
		expect(result.paused.probe).toEqual({ alive: true });
		expect(result.paused.stored).toEqual(Option.some(result.stopped));
		expect(result.paused.again).toMatchObject({
			_tag: "BudgetStopped",
			refusal: new LeaseFenced({ reason: "expired" }),
			review: { pass: 1, outcome: { _tag: "Deferred", attempt: 2 } },
		});
		expect(result.paused.requests).toBe(0);
		// Under a new lease the same answer is reviewed, as the same pass, and the thread ends reviewed.
		expect(result.resumed).toMatchObject({
			_tag: "Reviewed",
			accepted: false,
			counts: { turns: 1 },
			verdict: { pass: 1, corrections: 0, outcome: { _tag: "Passed" } },
		});
		const [first] = result.verdicts;
		expect(result.verdicts).toEqual([
			[1, "Deferred", first?.[2]],
			[1, "Deferred", first?.[2]],
			[1, "Passed", first?.[2]],
		]);
		expect(result.after).toEqual({ alive: false });
		// The author's request and the one review that was paid for: two refusals, and nothing sent for them.
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([1, 1]);
		expect(state.lease.steps.map((step) => step.step)).toEqual([
			"reserve",
			"settle",
			"fenced",
			"fenced",
			"reserve",
			"settle",
		]);
		expect(entryRecords(state).map((record) => record.kind)).toEqual([
			"review.verdict",
			"review.verdict",
			"review.verdict",
		]);
		// Each verdict's request is a model call record too: the two the budget refused as failed calls of the
		// reviewer the policy names, sent to no route, and the one that was paid for.
		const reviews = committed(state).flatMap((record) =>
			record._tag === "ModelCall" && record.derived !== undefined ? [record] : [],
		);
		expect(reviews.map(({ provider, model, stopReason }) => [provider, model, stopReason])).toEqual([
			["router", "reviewer", "error"],
			["router", "reviewer", "error"],
			["reviewer-lab", "judge", "stop"],
		]);
		expect(reviews.map((call) => [call.usage.totalTokens > 0, call.error === null])).toEqual([
			[false, false],
			[false, false],
			[true, true],
		]);
		// pi-ai answers a refused request with an error message of no tokens: the usage is held, and it is nothing.
		expect(reviews.map((call) => call.derived?.unknown.includes("usage"))).toEqual([false, false, false]);
	});

	it("gives a deferral its own outcome when the reviewer's provider fails, and a resume reviews the answer", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 42.")],
			reviewer: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }), CLEAN],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const deferred = yield* threads.work(work("t1", "What is six times seven?"));
				return { deferred, probe: yield* threads.probe("t1"), resumed: yield* threads.resume("t1") };
			}),
		);
		// The provider's own words, unchanged: no budget refusal decodes from them.
		expect(result.deferred).toMatchObject({
			_tag: "ReviewDeferred",
			reason: "overloaded",
			attempt: 1,
			counts: { turns: 1 },
			verdict: {
				call: { provider: JUDGE.provider, model: JUDGE.modelId, stopReason: "error", error: "overloaded" },
				outcome: { _tag: "Deferred", attempt: 1 },
			},
		});
		expect(result.probe).toEqual({ alive: true });
		expect(result.resumed).toMatchObject({ _tag: "Reviewed", verdict: { pass: 1, outcome: { _tag: "Passed" } } });
		// The failed request was sent and is settled as failed; the second one reviewed.
		expect(labs.reviewer.state.callCount).toBe(2);
		expect(reservations(state).map(({ request, settlements }) => [request.model, settlements[0]?.outcome])).toEqual([
			["author", "returned"],
			["reviewer", "failed"],
			["reviewer", "returned"],
		]);
	});

	it("is cancelled while its review is deferred: the thread ends cancelled, and a resume asks nobody", async () => {
		const state = outside();
		const labs = providers({
			author: [answer("It is 42.")],
			reviewer: [fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }), CLEAN],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const deferred = yield* threads.work(work("t1", "What is six times seven?"));
				yield* threads.cancel("t1");
				return { deferred: deferred._tag, resumed: yield* threads.resume("t1"), probe: yield* threads.probe("t1") };
			}),
		);
		expect(result.deferred).toBe("ReviewDeferred");
		expect(result.resumed).toMatchObject({ _tag: "Cancelled", counts: { turns: 1 } });
		expect(result.probe).toEqual({ alive: false });
		expect(labs.reviewer.state.callCount).toBe(1);
	});
});

describe("a thread that asks for no review", () => {
	it("ends answered: its conversation leaves the review out, and nobody is asked or paid to review", async () => {
		const state = outside();
		const labs = providers({ author: [answer("It is 42.")], reviewer: [CLEAN] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work({ ...work("t1", "What is six times seven?"), review: false });
				const conversation = yield* threads.conversation("t1");
				const agent = yield* conversation.agent;
				return {
					outcome,
					extensions: agent.extensions.map((extension) => extension.name),
					state: yield* Review.state(conversation),
					probe: yield* threads.probe("t1"),
					resumed: yield* threads.resume("t1"),
				};
			}),
		);
		const [only] = reservations(state);
		expect(result.outcome).toEqual({
			_tag: "Answered",
			counts: { turns: 1, toolCalls: 0, refusedToolCalls: 0, settledMicros: only?.settlements[0]?.cost },
		});
		// The guard is still asked first; only the review is gone from the thread's own selection.
		expect(result.extensions).toEqual([
			"guard",
			"app",
			"search",
			"approvals",
			"subagent",
			"swarm",
			"thread",
			"recorder",
		]);
		expect(result.state).toEqual({ _tag: "NotRequired" });
		expect(result.probe).toEqual({ alive: false });
		expect(result.resumed).toEqual(result.outcome);
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([1, 0]);
		expect(reservations(state)).toHaveLength(1);
		expect(entryRecords(state)).toEqual([]);
	});
});
