import { answer, held, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { type Finding, release, state, verdicts, waitForHoldEnd } from "../src/index.ts";
import { ask, findings, POLICY, reached, scene, textOf, transcript } from "./scene.ts";

const WRONG: Finding = { severity: "block", text: "Six times seven is 42." };
const STRICT = { ...POLICY, maxCorrections: 0 };

describe("release", () => {
	it("accepts a held answer as it is: the decision is recorded, and only then the submission settles", async () => {
		const blocked = scene({ policy: STRICT, author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const held = yield* reached(root, "Held");
				const before = yield* submission.status;
				const delivery = yield* release(root, { _tag: "Accept", by: "user:ada", note: "Checked by hand." });
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return {
					held,
					before: before.status,
					delivery,
					settled: settled.status,
					transcript: yield* transcript(root),
				};
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect([result.before, result.delivery, result.settled]).toEqual(["placed", "released", "done"]);
		expect(result.transcript).toEqual([
			["pi.user", "What is six times seven?"],
			["pi.assistant", "It is 41."],
			["review.verdict", result.held.verdict],
			[
				"review.release",
				{
					answer: result.held.verdict.answer,
					decision: { _tag: "Accept", by: "user:ada", note: "Checked by hand." },
					time: expect.any(Number),
				},
			],
		]);
		// Nobody was asked again: the answer stands as the author gave it.
		expect([blocked.authorRequests.length, blocked.reviewer.state.callCount]).toEqual([1, 1]);
	});

	it("continues the run with a person's correction, and reviews the next answer", async () => {
		const blocked = scene({
			policy: STRICT,
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const held = yield* reached(root, "Held");
				const delivery = yield* release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return {
					held,
					delivery,
					settled: settled.status,
					transcript: yield* transcript(root),
					state: yield* state(root),
				};
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect([result.delivery, result.settled]).toEqual(["released", "done"]);
		expect(result.transcript.map(([kind]) => kind)).toEqual([
			"pi.user",
			"pi.assistant",
			"review.verdict",
			"review.release",
			"pi.user",
			"pi.assistant",
			"review.verdict",
		]);
		expect(result.transcript[3]?.[1]).toEqual({
			answer: result.held.verdict.answer,
			decision: { _tag: "Correct", by: "user:bob", correction: "Multiply again." },
			time: expect.any(Number),
		});
		expect(result.transcript[4]).toEqual(["pi.user", "Multiply again."]);
		expect(textOf(blocked.authorRequests[1]?.at(-1))).toBe("Multiply again.");
		// The same run: its second review. A person's correction is no corrective run of the policy.
		expect(result.state).toMatchObject({
			_tag: "Reviewed",
			verdict: { pass: 2, corrections: 0, outcome: { _tag: "Passed" } },
		});
	});

	it("holds again at once when the answer to a person's correction is blocked: the run's corrections are spent", async () => {
		const stubborn = scene({
			author: [answer("It is 41."), answer("It is 43."), answer("It is 44.")],
			reviewer: [findings(WRONG), findings(WRONG), findings(WRONG)],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* ask();
				const first = yield* reached(root, "Held");
				yield* release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
				// The first hold ends when its task does; the next one is a new task.
				for (;;) {
					const current = yield* reached(root, "Held");
					if (current.task !== first.task) break;
					yield* Effect.yieldNow;
				}
				const stored = yield* Stream.runCollect(verdicts(root));
				return stored.map((entry) => [entry.data.pass, entry.data.corrections, entry.data.outcome._tag]);
			}).pipe(Effect.provide(stubborn.layer)),
		);
		expect(result).toEqual([
			[1, 1, "Corrected"],
			[2, 1, "Held"],
			[3, 1, "Held"],
		]);
		expect(stubborn.authorRequests.length).toBe(3);
	});

	it("fails with NotHeld, and changes nothing, for a conversation that is not held", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const empty = yield* Effect.flip(release(root, { _tag: "Accept", by: "user:ada" }));
				yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const reviewed = yield* Effect.flip(release(root, { _tag: "Accept", by: "user:ada" }));
				return { errors: [empty, reviewed], kinds: (yield* transcript(root)).map(([kind]) => kind) };
			}).pipe(Effect.provide(clean.layer)),
		);
		expect(
			result.errors.map((error) => (error._tag === "NotHeld" ? [error.conversationId, error.state] : error._tag)),
		).toEqual([
			[expect.any(Number), "NotReviewed"],
			[expect.any(Number), "Reviewed"],
		]);
		expect(result.kinds).toEqual(["pi.user", "pi.assistant", "review.verdict"]);
	});

	it("loses a person's correction to a message queued during the hold, as Pi drops any continuation then", async () => {
		const blocked = scene({
			policy: STRICT,
			author: [answer("It is 41."), answer("It is 56.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reached(root, "Held");
				const next = yield* root.submit({ type: "input", content: "And seven times eight?" });
				yield* release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
				yield* submission.wait;
				yield* next.wait;
				yield* root.waitForIdle;
				return { transcript: yield* transcript(root), state: yield* state(root) };
			}).pipe(Effect.provide(blocked.layer)),
		);
		// The decision is recorded, its text never reached the author, and the queued message was answered and reviewed.
		expect(result.transcript.map(([kind, data]) => (typeof data === "string" ? data : kind))).toEqual([
			"What is six times seven?",
			"It is 41.",
			"review.verdict",
			"review.release",
			"And seven times eight?",
			"It is 56.",
			"review.verdict",
		]);
		expect(result.state).toMatchObject({ _tag: "Reviewed", verdict: { pass: 1 } });
	});
});

describe("waitForHoldEnd", () => {
	it("gives the state the hold ended with: accepted once the task took the decision (gap 11)", async () => {
		const blocked = scene({ policy: STRICT, author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* ask();
				const before = yield* reached(root, "Held");
				yield* release(root, { _tag: "Accept", by: "user:ada" });
				return { before, after: yield* waitForHoldEnd(root) };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.after).toEqual({
			_tag: "Accepted",
			verdict: result.before.verdict,
			release: {
				answer: result.before.verdict.answer,
				decision: { _tag: "Accept", by: "user:ada" },
				time: expect.any(Number),
			},
		});
	});

	it("gives in review after a correction: the run goes on, and nothing is held", async () => {
		const correcting = held(answer("It is 42."));
		const blocked = scene({
			policy: STRICT,
			author: [answer("It is 41."), correcting.response],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const before = yield* reached(root, "Held");
				yield* release(root, { _tag: "Correct", by: "user:bob", correction: "Multiply again." });
				const after = yield* waitForHoldEnd(root);
				yield* correcting.release;
				yield* submission.wait;
				return { before, after };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.after).toEqual({ _tag: "InReview", verdict: result.before.verdict });
	});

	it("waits while nobody decided, and ends with the hold when the conversation is aborted", async () => {
		const blocked = scene({ policy: STRICT, author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* ask();
				yield* reached(root, "Held");
				const waiting = yield* Effect.forkChild(waitForHoldEnd(root));
				yield* Effect.sleep("30 millis");
				const pending = waiting.pollUnsafe() === undefined;
				yield* root.abort();
				return { pending, after: yield* Fiber.join(waiting) };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.pending).toBe(true);
		expect(result.after).toMatchObject({ _tag: "NotReviewed", reason: "hold_ended" });
	});

	it("gives the state at once for a conversation that is not held", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const empty = yield* waitForHoldEnd(root);
				yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				return [empty, yield* waitForHoldEnd(root)];
			}).pipe(Effect.provide(clean.layer)),
		);
		expect(states.map((each) => each._tag)).toEqual(["NotReviewed", "Reviewed"]);
	});
});
