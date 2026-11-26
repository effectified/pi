import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Check, type Finding, retry, state, verdicts } from "../src/index.ts";
import { ask, CALL, findings, PARTIES, POLICY, REVIEWED, reached, scene, transcript } from "./scene.ts";

const WRONG: Finding = { severity: "block", text: "Six times seven is 42." };
const FAILED = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });

/** The verdict of a request that failed, as the scripted reviewer's error leaves it. */
const deferred = (task: number, attempt: number) => ({
	answer: expect.any(Number),
	inputs: [expect.any(Number)],
	pass: 1,
	corrections: 0,
	...PARTIES,
	call: { ...CALL, stopReason: "error", error: "overloaded" },
	findings: [],
	failures: [{ check: "review.model", error: "The reviewer reviewer-lab/judge did not answer: overloaded" }],
	outcome: { _tag: "Deferred", task, attempt },
	time: expect.any(Number),
});

describe("retry", () => {
	it("reviews the same answer again as the same pass, and lets it stand when it passes (gap 2)", async () => {
		const once = scene({ author: [answer("It is 42.")], reviewer: [FAILED, findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const before = yield* reached(root, "Deferred");
				const asked = yield* retry(root);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return {
					before,
					asked,
					settled: settled.status,
					state: yield* state(root),
					transcript: yield* transcript(root),
				};
			}).pipe(Effect.provide(once.layer)),
		);
		const passed = { ...REVIEWED, pass: 1, corrections: 0, findings: [], failures: [], outcome: { _tag: "Passed" } };
		expect([result.asked, result.settled]).toEqual(["retrying", "done"]);
		// Two verdicts about one answer: the request that failed, then the review, counted once.
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 42."],
			["review.verdict", deferred(result.before.task, 1)],
			["review.verdict", passed],
		]);
		expect(result.state).toEqual({ _tag: "Reviewed", verdict: passed });
		expect([once.authorRequests.length, once.reviewer.state.callCount]).toEqual([1, 2]);
	});

	it("corrects the run when the later review blocks, and counts the corrected answer as the second pass", async () => {
		const blocked = scene({
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [FAILED, findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reached(root, "Deferred");
				yield* retry(root);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const stored = yield* Stream.runCollect(verdicts(root));
				return {
					settled: settled.status,
					state: yield* state(root),
					stored: stored.map((entry) => [entry.data.pass, entry.data.corrections, entry.data.outcome._tag]),
					kinds: (yield* transcript(root)).map(([kind]) => kind),
				};
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.stored).toEqual([
			[1, 0, "Deferred"],
			[1, 1, "Corrected"],
			[2, 1, "Passed"],
		]);
		expect(result.kinds).toEqual([
			"pi.user",
			"pi.assistant",
			"review.verdict",
			"review.verdict",
			"pi.user",
			"pi.assistant",
			"review.verdict",
		]);
		expect([result.settled, result.state._tag]).toEqual(["done", "Reviewed"]);
		expect([blocked.authorRequests.length, blocked.reviewer.state.callCount]).toEqual([2, 3]);
	});

	it("holds the conversation when the later review blocks and no correction is left", async () => {
		const strict = scene({
			policy: { ...POLICY, maxCorrections: 0 },
			author: [answer("It is 41.")],
			reviewer: [FAILED, findings(WRONG)],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const before = yield* reached(root, "Deferred");
				yield* retry(root);
				const held = yield* reached(root, "Held");
				return { before: before.task, held, submission: (yield* submission.status).status };
			}).pipe(Effect.provide(strict.layer)),
		);
		// The same task reviewed again, and now holds.
		expect(result.held.task).toBe(result.before);
		expect(result.held.verdict).toMatchObject({ pass: 1, corrections: 0, outcome: { _tag: "Held" } });
		expect(result.submission).toBe("placed");
	});

	it("defers again when the request fails again, under the next attempt, and can be asked again", async () => {
		const twice = scene({ author: [answer("It is 42.")], reviewer: [FAILED, FAILED, findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const first = yield* reached(root, "Deferred");
				yield* retry(root);
				const second = yield* reached(root, "Deferred", (deferred) => deferred.attempt !== first.attempt);
				yield* retry(root);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { first, second, settled: settled.status, transcript: yield* transcript(root) };
			}).pipe(Effect.provide(twice.layer)),
		);
		expect([result.first.attempt, result.second.attempt, result.second.task]).toEqual([1, 2, result.first.task]);
		expect(result.transcript.slice(2).map(([, data]) => data)).toEqual([
			deferred(result.first.task, 1),
			deferred(result.first.task, 2),
			{ ...REVIEWED, pass: 1, corrections: 0, findings: [], failures: [], outcome: { _tag: "Passed" } },
		]);
		expect([result.settled, twice.reviewer.state.callCount]).toEqual(["done", 3]);
	});

	it("runs every check again for the new verdict: each attempt has memos of its own", async () => {
		let runs = 0;
		const counted = Check.make("app.counted", () => Effect.sync(() => void runs++).pipe(Effect.as([])));
		const once = scene({ checks: [counted], author: [answer("It is 42.")], reviewer: [FAILED, findings()] });
		await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reached(root, "Deferred");
				yield* retry(root);
				yield* submission.wait;
			}).pipe(Effect.provide(once.layer)),
		);
		expect(runs).toBe(2);
	});

	it("fails with NotDeferred, and changes nothing, for a conversation whose review is not deferred", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const empty = yield* Effect.flip(retry(root));
				yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const reviewed = yield* Effect.flip(retry(root));
				return { errors: [empty, reviewed], kinds: (yield* transcript(root)).map(([kind]) => kind) };
			}).pipe(Effect.provide(clean.layer)),
		);
		expect(
			result.errors.map((error) =>
				error._tag === "NotDeferred" ? [error.conversationId, error.state] : error._tag,
			),
		).toEqual([
			[expect.any(Number), "NotReviewed"],
			[expect.any(Number), "Reviewed"],
		]);
		expect(result.kinds).toEqual(["pi.user", "pi.assistant", "review.verdict"]);
		expect(clean.reviewer.state.callCount).toBe(1);
	});

	it("ends with a verdict that says the review was aborted when the conversation is aborted while deferred", async () => {
		const failing = scene({ author: [answer("It is 42.")], reviewer: [FAILED] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const before = yield* reached(root, "Deferred");
				yield* root.abort();
				const settled = yield* submission.wait;
				const again = yield* Effect.flip(retry(root));
				return { before, settled: settled.status, state: yield* state(root), again: again._tag };
			}).pipe(Effect.provide(failing.layer)),
		);
		expect(result.state).toEqual({
			_tag: "NotReviewed",
			reason: "review_aborted",
			// The failed request is in the deferred verdict: this one keeps none, so no call is recorded twice.
			verdict: {
				answer: result.before.verdict.answer,
				inputs: result.before.verdict.inputs,
				pass: 1,
				corrections: 0,
				...PARTIES,
				findings: [],
				failures: [],
				outcome: { _tag: "NotReviewed", reason: "review_aborted" },
				time: expect.any(Number),
			},
		});
		expect([result.settled, result.again]).toEqual(["done", "NotDeferred"]);
	});
});
