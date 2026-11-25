import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness } from "@gunta/pi-durable-effect";
import { answer, held, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Check, Correction, type Finding, state, verdicts } from "../src/index.ts";
import {
	AUTHOR,
	aliasProvider,
	ask,
	CALL,
	findings,
	PARTIES,
	POLICY,
	REVIEWED,
	REVIEWER,
	reached,
	route,
	type Scene,
	scene,
	textOf,
	transcript,
} from "./scene.ts";

const WRONG: Finding = { severity: "block", text: "Six times seven is 42.", location: "It is 41." };
const TERSE: Finding = { severity: "warn", text: "Show the multiplication." };

/** Asks the question on `given` and waits for the run to end; what the conversation then holds. */
function settled<R>(given: Scene<R>) {
	return Effect.gen(function* () {
		const { root, submission } = yield* ask();
		const record = yield* submission.wait;
		yield* root.waitForIdle;
		return { status: record.status, transcript: yield* transcript(root), state: yield* state(root) };
	}).pipe(Effect.provide(given.layer));
}

describe("a review without a blocking finding", () => {
	it("lets the answer stand and stores the exact verdict in the task's commit", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const result = await Effect.runPromise(settled(clean));
		const verdict = { ...REVIEWED, pass: 1, corrections: 0, findings: [], failures: [], outcome: { _tag: "Passed" } };
		expect(result.status).toBe("done");
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 42."],
			["review.verdict", verdict],
		]);
		expect(result.state).toEqual({ _tag: "Reviewed", verdict });
		expect([clean.authorRequests.length, clean.reviewer.state.callCount]).toEqual([1, 1]);
	});

	it("keeps findings below the policy's blocking severity in the verdict and passes", async () => {
		const remarked = scene({ author: [answer("It is 42.")], reviewer: [findings(TERSE)] });
		const result = await Effect.runPromise(settled(remarked));
		expect(result.state).toMatchObject({
			_tag: "Reviewed",
			verdict: { findings: [{ check: "review.model", ...TERSE }], outcome: { _tag: "Passed" } },
		});
		expect(remarked.authorRequests.length).toBe(1);
	});

	it("blocks from the severity the policy names", async () => {
		const strict = scene({
			policy: { ...POLICY, blocking: "warn", maxCorrections: 0 },
			author: [answer("It is 42.")],
			reviewer: [findings(TERSE)],
		});
		const held = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* ask();
				return yield* reached(root, "Held");
			}).pipe(Effect.provide(strict.layer)),
		);
		expect(held.verdict.outcome).toEqual({ _tag: "Held", task: held.task });
	});

	it("gives the reviewer the task, the run and the answer, under the conversation's provider session", async () => {
		const clean = scene({
			policy: { ...POLICY, instructions: "Check the arithmetic." },
			author: [answer("It is 42.")],
			reviewer: [findings()],
		});
		await Effect.runPromise(settled(clean));
		const [request] = clean.reviewerRequests;
		const [system, user] = request?.messages ?? [];
		expect(request?.messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(system?.role === "system" ? system.content : undefined).toMatch(/\n\nCheck the arithmetic\.$/);
		expect(textOf(user)).toBe(
			[
				"# Task\n\nWhat is six times seven?",
				"# Transcript of the run\n\nUser: What is six times seven?\n\nAssistant: It is 42.",
				"# Answer under review\n\nIt is 42.",
			].join("\n\n"),
		);
		// Pi's own session id of the conversation: a UUID.
		expect(request?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("a blocking finding", () => {
	it("sends the run back once with the findings, then stores a clean second verdict", async () => {
		const corrected = scene({
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG, TERSE), findings()],
		});
		const result = await Effect.runPromise(settled(corrected));
		const message = Correction.standard({
			pass: 1,
			blocking: [{ check: "review.model", ...WRONG }],
			remarks: [{ check: "review.model", ...TERSE }],
		});
		expect(message).toBe(
			[
				"A review of your answer found problems that must be fixed:",
				"1. [block] Six times seven is 42. (at: It is 41.)",
				"Other remarks:",
				"- [warn] Show the multiplication.",
				"Correct your answer and give it again in full.",
			].join("\n"),
		);
		const first = {
			...REVIEWED,
			pass: 1,
			corrections: 1,
			findings: [
				{ check: "review.model", ...WRONG },
				{ check: "review.model", ...TERSE },
			],
			failures: [],
			outcome: { _tag: "Corrected" },
		};
		const second = { ...first, pass: 2, findings: [], outcome: { _tag: "Passed" } };
		expect(result.status).toBe("done");
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 41."],
			["review.verdict", first],
			["pi.user", message],
			["pi.assistant", "It is 42."],
			["review.verdict", second],
		]);
		expect(result.state).toEqual({ _tag: "Reviewed", verdict: second });
		// Exactly one corrective run, and the author read the findings in it.
		expect(corrected.authorRequests.length).toBe(2);
		expect(textOf(corrected.authorRequests[1]?.at(-1))).toBe(message);
		expect(corrected.reviewer.state.callCount).toBe(2);
	});

	it("lets the product write the correction message", async () => {
		const shaped = scene({
			correction: ({ pass, blocking }) => `Pass ${pass}: ${blocking.map((finding) => finding.text).join(" ")}`,
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		await Effect.runPromise(settled(shaped));
		expect(textOf(shaped.authorRequests[1]?.at(-1))).toBe("Pass 1: Six times seven is 42.");
	});

	it("writes this package's message when the product's writer throws", async () => {
		const broken = scene({
			correction: () => {
				throw new Error("no template");
			},
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(settled(broken));
		expect(textOf(broken.authorRequests[1]?.at(-1))).toMatch(/^A review of your answer found problems/);
		expect(result.state._tag).toBe("Reviewed");
	});
});

describe.each([0, 1, 2])("%i corrective runs allowed, and every verdict blocks", (maxCorrections) => {
	it(`holds the conversation after exactly ${maxCorrections} corrective runs`, async () => {
		const stubborn = scene({
			policy: { ...POLICY, maxCorrections },
			author: Array.from({ length: maxCorrections + 1 }, () => answer("It is 41.")),
			reviewer: Array.from({ length: maxCorrections + 1 }, () => findings(WRONG)),
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const held = yield* reached(root, "Held");
				const stored = yield* Stream.runCollect(verdicts(root));
				return { held, stored: stored.map((entry) => entry.data), submission: yield* submission.status };
			}).pipe(Effect.provide(stubborn.layer)),
		);
		expect(result.stored.map((verdict) => [verdict.pass, verdict.corrections, verdict.outcome._tag])).toEqual([
			...Array.from({ length: maxCorrections }, (_, index) => [index + 1, index + 1, "Corrected"]),
			[maxCorrections + 1, maxCorrections, "Held"],
		]);
		expect(result.held.verdict).toEqual(result.stored.at(-1));
		expect(result.held.verdict.outcome).toEqual({ _tag: "Held", task: result.held.task });
		// The author ran once, then once per correction, and never again; the submission is not settled.
		expect(stubborn.authorRequests.length).toBe(maxCorrections + 1);
		expect(stubborn.reviewer.state.callCount).toBe(maxCorrections + 1);
		expect(result.submission.status).toBe("placed");
	});
});

describe("a product's check", () => {
	const Length = Check.make("app.length", (subject) =>
		Effect.succeed<ReadonlyArray<Finding>>(
			subject.answer.length > 12 ? [{ severity: "block", text: "Answer in at most twelve characters." }] : [],
		),
	);

	it("runs after the model review, on the answer and its run, and its findings block like any other", async () => {
		const seen: Check.Subject[] = [];
		const Seen = Check.make("app.seen", (subject) => Effect.sync(() => void seen.push(subject)).pipe(Effect.as([])));
		const checked = scene({
			checks: [Length, Seen],
			author: [answer("It is forty-two."), answer("It is 42.")],
			reviewer: [findings(), findings()],
		});
		const result = await Effect.runPromise(settled(checked));
		expect(result.transcript.filter(([kind]) => kind === "review.verdict").map(([, data]) => data)).toMatchObject([
			{
				pass: 1,
				findings: [{ check: "app.length", severity: "block", text: "Answer in at most twelve characters." }],
				outcome: { _tag: "Corrected" },
			},
			{ pass: 2, findings: [], outcome: { _tag: "Passed" } },
		]);
		expect(seen.map((subject) => [subject.pass, subject.answer, subject.author, subject.transcript.length])).toEqual([
			[1, "It is forty-two.", PARTIES.author, 2],
			[2, "It is 42.", PARTIES.author, 4],
		]);
		expect(seen[0]?.answerId).toBe((result.transcript[2]?.[1] as { answer: number }).answer);
		expect([AUTHOR.provider, REVIEWER.provider]).toEqual(["author-lab", "reviewer-lab"]);
	});
});

describe("an answer the reviewer may not review", () => {
	const SAME = [PARTIES.author, { ...REVIEWER, family: "alpha" }];
	const cases = [
		["a reviewer of the author's family", { families: SAME }, "same_family", { ...REVIEWER, family: "alpha" }],
		["an author without a family", { families: [PARTIES.reviewer] }, "author_family_unknown", PARTIES.reviewer],
		["a reviewer without a family", { families: [PARTIES.author] }, "reviewer_family_unknown", REVIEWER],
	] as const;

	it.each(cases)(
		"%s: not reviewed, recorded, and the reviewer is never asked",
		async (_name, change, reason, reviewer) => {
			const refused = scene({
				policy: { ...POLICY, ...change },
				author: [answer("It is 41.")],
				reviewer: [findings(WRONG)],
			});
			const result = await Effect.runPromise(settled(refused));
			const verdict = {
				answer: expect.any(Number),
				pass: 1,
				corrections: 0,
				author: reason === "author_family_unknown" ? AUTHOR : PARTIES.author,
				reviewer,
				findings: [],
				failures: [],
				outcome: { _tag: "NotReviewed", reason },
				time: expect.any(Number),
			};
			expect(result.transcript).toEqual([
				["pi.user", "What is six times seven?"],
				["pi.assistant", "It is 41."],
				["review.verdict", verdict],
			]);
			expect(result.state).toEqual({ _tag: "NotReviewed", reason, verdict });
			// The run ended with the answer, and nobody was asked to review it.
			expect([result.status, refused.authorRequests.length, refused.reviewer.state.callCount]).toEqual([
				"done",
				1,
				0,
			]);
		},
	);

	it("a reviewer model the harness does not have: not reviewed, recorded, and no request", async () => {
		const missing = scene({ reviewerInstalled: false, author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
		const result = await Effect.runPromise(settled(missing));
		expect(result.state).toMatchObject({
			_tag: "NotReviewed",
			reason: "no_reviewer_model",
			verdict: { ...PARTIES, findings: [], outcome: { _tag: "NotReviewed", reason: "no_reviewer_model" } },
		});
		expect([result.status, missing.authorRequests.length, missing.reviewer.state.callCount]).toEqual(["done", 1, 0]);
	});

	it("runs no check of the product either", async () => {
		let ran = 0;
		const counted = Check.make("app.counted", () =>
			Effect.sync(() => {
				ran += 1;
				return [];
			}),
		);
		const refused = scene({
			policy: { ...POLICY, families: SAME },
			checks: [counted],
			author: [answer("It is 41.")],
		});
		await Effect.runPromise(settled(refused));
		expect(ran).toBe(0);
	});
});

describe("a check that fails", () => {
	const Down = Check.make("app.down", () => Effect.fail(new Error("The index is down")));
	const Broken = Check.make("app.broken", () => Effect.die("boom"));

	it("never passes the answer: it is recorded as not reviewed, with the failure", async () => {
		const failing = scene({ checks: [Down, Broken], author: [answer("It is 42.")], reviewer: [findings(TERSE)] });
		const result = await Effect.runPromise(settled(failing));
		const verdict = {
			...REVIEWED,
			pass: 1,
			corrections: 0,
			findings: [{ check: "review.model", ...TERSE }],
			failures: [
				{ check: "app.down", error: "The index is down" },
				{ check: "app.broken", error: "boom" },
			],
			outcome: { _tag: "NotReviewed", reason: "check_failed" },
		};
		expect(result.state).toEqual({ _tag: "NotReviewed", reason: "check_failed", verdict });
		expect(result.transcript.at(-1)).toEqual(["review.verdict", verdict]);
		expect([result.status, failing.authorRequests.length]).toEqual(["done", 1]);
	});

	it("does not hide a blocking finding of another check: the run is corrected, and the failure is kept", async () => {
		const failing = scene({
			checks: [Down],
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(settled(failing));
		expect(result.transcript.filter(([kind]) => kind === "review.verdict").map(([, data]) => data)).toMatchObject([
			{ failures: [{ check: "app.down", error: "The index is down" }], outcome: { _tag: "Corrected" } },
			{ failures: [{ check: "app.down", error: "The index is down" }], outcome: { _tag: "NotReviewed" } },
		]);
		expect(result.state).toMatchObject({ _tag: "NotReviewed", reason: "check_failed" });
	});
});

describe("the reviewer's request in the verdict", () => {
	it("keeps who answered, how the response ended and what it used, and dates the verdict by the harness clock", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const before = Date.now();
		const result = await Effect.runPromise(settled(clean));
		const verdict = result.state._tag === "Reviewed" ? result.state.verdict : undefined;
		// The scripted provider counts tokens from the text: the request was written to its cache, the answer is output.
		const usage = verdict?.call?.usage;
		expect(verdict?.call).toEqual({
			provider: "reviewer-lab",
			model: "judge",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 4,
				cacheRead: 0,
				cacheWrite: usage?.cacheWrite,
				totalTokens: usage?.totalTokens,
				cost: 0,
			},
		});
		expect(usage?.cacheWrite).toBeGreaterThan(0);
		expect(usage?.totalTokens).toBe((usage?.cacheWrite ?? 0) + 4);
		expect(verdict?.time).toBeGreaterThanOrEqual(before);
		expect(verdict?.time).toBeLessThanOrEqual(Date.now());
	});

	it("keeps no request for a review that asked nobody", async () => {
		const refused = scene({ policy: { ...POLICY, families: [PARTIES.author] }, author: [answer("It is 42.")] });
		const result = await Effect.runPromise(settled(refused));
		const verdict = result.state._tag === "NotReviewed" ? result.state.verdict : undefined;
		expect([verdict?.outcome, Object.keys(verdict ?? {}).includes("call")]).toEqual([
			{ _tag: "NotReviewed", reason: "reviewer_family_unknown" },
			false,
		]);
	});
});

describe("the family rule and the model that reviewed", () => {
	const ALIAS = { provider: "router", modelId: "reviewer" };
	const JUDGE = { provider: "judge-lab", modelId: "judge-2" };
	const FAILED = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });
	const WRONG_AGAIN: Finding = { severity: "block", text: "It is not 42." };
	/** The alias is of family beta, as its first route is; its second route is the author's own model. */
	const families = [PARTIES.author, { ...ALIAS, family: "beta" }, { ...JUDGE, family: "beta" }];

	/** A scene whose reviewer is the alias over `routes`; each route answers with its own script. */
	function behindAlias<R = never>(
		routes: readonly [ReadonlyArray<FauxResponseStep>, ReadonlyArray<FauxResponseStep>],
		checks: ReadonlyArray<Check.Check<R>> = [],
	) {
		const judge = route(JUDGE);
		const clone = route(AUTHOR);
		judge.setResponses([...routes[0]]);
		clone.setResponses([...routes[1]]);
		const given = scene({
			policy: { ...POLICY, reviewer: ALIAS, families },
			checks,
			providers: [aliasProvider(ALIAS, [judge, clone])],
			author: [answer("It is 41."), answer("It is 42.")],
		});
		return { given, judge, clone };
	}

	it("names the route that served as the reviewer, with its own family, when the alias is asked", async () => {
		const { given, judge, clone } = behindAlias([[findings(TERSE)], []]);
		const result = await Effect.runPromise(settled(given));
		expect(result.state).toEqual({
			_tag: "Reviewed",
			verdict: {
				answer: expect.any(Number),
				pass: 1,
				corrections: 0,
				author: PARTIES.author,
				// The route, not the alias the policy names.
				reviewer: { ...JUDGE, family: "beta" },
				call: { ...CALL, provider: JUDGE.provider, model: JUDGE.modelId },
				findings: [{ check: "review.model", ...TERSE }],
				failures: [],
				outcome: { _tag: "Passed" },
				time: expect.any(Number),
			},
		});
		expect([judge.state.callCount, clone.state.callCount]).toEqual([1, 0]);
	});

	it("never passes an answer its author's own model judged: not reviewed, same_family, and the findings are no review (gap 1)", async () => {
		let ran = 0;
		const counted = Check.make("app.counted", () => Effect.sync(() => void ran++).pipe(Effect.as([])));
		// The first route fails without output, so the route of the author's family serves, and blocks the answer.
		const { given, judge, clone } = behindAlias([[FAILED], [findings(WRONG_AGAIN)]], [counted]);
		const result = await Effect.runPromise(settled(given));
		const verdict = {
			answer: expect.any(Number),
			pass: 1,
			corrections: 0,
			author: PARTIES.author,
			reviewer: PARTIES.author,
			call: { ...CALL, provider: AUTHOR.provider, model: AUTHOR.modelId },
			findings: [],
			failures: [],
			outcome: { _tag: "NotReviewed", reason: "same_family" },
			time: expect.any(Number),
		};
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 41."],
			["review.verdict", verdict],
		]);
		expect(result.state).toEqual({ _tag: "NotReviewed", reason: "same_family", verdict });
		// The run ended with the answer: no correction was asked for, and no check of the product ran.
		expect([result.status, given.authorRequests.length, judge.state.callCount, clone.state.callCount, ran]).toEqual([
			"done",
			1,
			1,
			1,
			0,
		]);
	});

	it("does not review with a route the family table does not place", async () => {
		// The alias is placed, so the request is made; the route that answers is not.
		const judge = route(JUDGE);
		judge.setResponses([findings()]);
		const asked = scene({
			policy: { ...POLICY, reviewer: ALIAS, families: [PARTIES.author, { ...ALIAS, family: "beta" }] },
			providers: [aliasProvider(ALIAS, [judge])],
			author: [answer("It is 42.")],
		});
		const result = await Effect.runPromise(settled(asked));
		expect(result.state).toMatchObject({
			_tag: "NotReviewed",
			reason: "reviewer_family_unknown",
			verdict: { reviewer: JUDGE, call: { provider: JUDGE.provider, model: JUDGE.modelId }, findings: [] },
		});
		expect([result.status, judge.state.callCount, asked.authorRequests.length]).toEqual(["done", 1, 1]);
	});

	it("takes the author's family from the model that wrote the answer, not from the model the conversation names", async () => {
		// The conversation runs with an alias the table does not place; the route that writes is of family alpha.
		const WRITERS = { provider: "router", modelId: "author" };
		const writer = route(AUTHOR);
		writer.setResponses([answer("It is 42.")]);
		const routed = scene({ providers: [aliasProvider(WRITERS, [writer])], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.configure({ model: WRITERS });
				const record = yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				return { status: record.status, state: yield* state(root), agent: (yield* root.agent).model };
			}).pipe(Effect.provide(routed.layer)),
		);
		expect(result.agent).toEqual({ provider: "router", modelId: "author" });
		expect(result.state).toMatchObject({
			_tag: "Reviewed",
			verdict: { author: PARTIES.author, reviewer: PARTIES.reviewer, outcome: { _tag: "Passed" } },
		});
		expect([result.status, writer.state.callCount, routed.authorRequests.length]).toEqual(["done", 1, 0]);
	});
});

describe("a reviewer's request that failed", () => {
	const FAILED = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });

	it("defers the review: the verdict says so with the provider's error, the task waits, and the run stays open (gap 2)", async () => {
		const failing = scene({ author: [answer("It is 42.")], reviewer: [FAILED] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const deferred = yield* reached(root, "Deferred");
				const task = yield* Harness.getTask(deferred.task);
				return {
					deferred,
					transcript: yield* transcript(root),
					submission: (yield* submission.status).status,
					task: Option.map(task, (found) => found.state.status),
				};
			}).pipe(Effect.provide(failing.layer)),
		);
		const verdict = {
			answer: expect.any(Number),
			pass: 1,
			corrections: 0,
			...PARTIES,
			call: { ...CALL, stopReason: "error", error: "overloaded" },
			findings: [],
			failures: [{ check: "review.model", error: "The reviewer reviewer-lab/judge did not answer: overloaded" }],
			outcome: { _tag: "Deferred", task: result.deferred.task, attempt: 1 },
			time: expect.any(Number),
		};
		expect(result.deferred).toEqual({
			_tag: "Deferred",
			verdict,
			task: expect.any(Number),
			attempt: 1,
			reason: "overloaded",
		});
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 42."],
			["review.verdict", verdict],
		]);
		// Pi's terms: the inputs are open, the task sleeps, and nobody was asked twice.
		expect([result.submission, result.task]).toEqual(["placed", Option.some("sleeping")]);
		expect([failing.authorRequests.length, failing.reviewer.state.callCount]).toEqual([1, 1]);
	});

	it("defers a request the provider threw for, with what it threw and no usage", async () => {
		const thrown = scene({
			author: [answer("It is 42.")],
			reviewer: [
				() => {
					throw new Error("socket closed");
				},
			],
		});
		const deferred = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* ask();
				return yield* reached(root, "Deferred");
			}).pipe(Effect.provide(thrown.layer)),
		);
		expect(deferred.reason).toContain("socket closed");
		expect(deferred.verdict.call).toMatchObject({ provider: "reviewer-lab", model: "judge", stopReason: "error" });
	});

	it("does not defer when another check blocks: the run is corrected, and the failed request is kept", async () => {
		const Short = Check.make("app.short", (subject) =>
			Effect.succeed<ReadonlyArray<Finding>>(
				subject.answer.includes("42") ? [] : [{ severity: "block", text: "Say 42." }],
			),
		);
		const failing = scene({
			checks: [Short],
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [FAILED, findings()],
		});
		const result = await Effect.runPromise(settled(failing));
		expect(result.transcript.filter(([kind]) => kind === "review.verdict").map(([, data]) => data)).toMatchObject([
			{
				pass: 1,
				call: { stopReason: "error", error: "overloaded" },
				findings: [{ check: "app.short", severity: "block", text: "Say 42." }],
				failures: [{ check: "review.model" }],
				outcome: { _tag: "Corrected" },
			},
			{ pass: 2, findings: [], failures: [], outcome: { _tag: "Passed" } },
		]);
		expect(result.state._tag).toBe("Reviewed");
	});
});

describe("a review that is aborted", () => {
	it("stores a verdict that says so, with the request the reviewer had answered, and ends the run (gap 9)", async () => {
		const checking = Promise.withResolvers<void>();
		const Slow = Check.make("app.slow", () =>
			Effect.andThen(
				Effect.sync(() => checking.resolve()),
				Effect.never,
			),
		);
		const cut = scene({ checks: [Slow], author: [answer("It is 42.")], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* Effect.promise(() => checking.promise);
				yield* root.abort();
				const record = yield* submission.wait;
				return { status: record.status, state: yield* state(root), transcript: yield* transcript(root) };
			}).pipe(Effect.provide(cut.layer)),
		);
		const verdict = {
			...REVIEWED,
			pass: 1,
			corrections: 0,
			findings: [],
			failures: [],
			outcome: { _tag: "NotReviewed", reason: "review_aborted" },
		};
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 42."],
			["review.verdict", verdict],
		]);
		expect(result.state).toEqual({ _tag: "NotReviewed", reason: "review_aborted", verdict });
		// Pi's own rule for an abort after the answer: the inputs settle `done` with it.
		expect(result.status).toBe("done");
	});

	it("keeps no request when the reviewer had not answered", async () => {
		const reading = held(findings());
		const cut = scene({ author: [answer("It is 42.")], reviewer: [reading.response] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reading.requested;
				yield* root.abort();
				yield* submission.wait;
				return yield* state(root);
			}).pipe(Effect.provide(cut.layer)),
		);
		expect(result).toEqual({
			_tag: "NotReviewed",
			reason: "review_aborted",
			verdict: {
				answer: expect.any(Number),
				pass: 1,
				corrections: 0,
				...PARTIES,
				findings: [],
				failures: [],
				outcome: { _tag: "NotReviewed", reason: "review_aborted" },
				time: expect.any(Number),
			},
		});
	});
});
