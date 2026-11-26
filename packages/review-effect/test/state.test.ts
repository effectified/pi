import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { Extension, Harness, Hook } from "@effectified/pi-durable";
import { answer, held, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	type Finding,
	NAME,
	release,
	retry,
	State,
	state,
	VerdictEntry,
	verdicts,
	waitForHoldEnd,
	waitOf,
} from "../src/index.ts";
import { AUTHOR, ask, findings, PARTIES, POLICY, reached, scene, transcript } from "./scene.ts";

const WRONG: Finding = { severity: "block", text: "Six times seven is 42." };

describe("state", () => {
	it("reads a conversation without an answer as not reviewed", async () => {
		const empty = scene();
		const read = Effect.flatMap(TestHarness.root, state).pipe(Effect.provide(empty.layer));
		expect(await Effect.runPromise(read)).toEqual({ _tag: "NotReviewed", reason: "no_answer" });
	});

	it("reads in review while the author writes and while the reviewer reads, then reviewed", async () => {
		const writing = held(answer("It is 42."));
		const reading = held(findings());
		const slow = scene({ author: [writing.response], reviewer: [reading.response] });
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* writing.requested;
				const whileWriting = yield* state(root);
				yield* writing.release;
				yield* reading.requested;
				const whileReading = yield* state(root);
				yield* reading.release;
				yield* submission.wait;
				yield* root.waitForIdle;
				return [whileWriting, whileReading, yield* state(root)];
			}).pipe(Effect.provide(slow.layer)),
		);
		expect(states.map((each) => each._tag)).toEqual(["InReview", "InReview", "Reviewed"]);
	});

	it("reads in review, with the verdict that asked, while a corrective run is under way", async () => {
		const correcting = held(answer("It is 42."));
		const slow = scene({
			author: [answer("It is 41."), correcting.response],
			reviewer: [findings(WRONG), findings()],
		});
		const during = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* correcting.requested;
				const current = yield* state(root);
				yield* correcting.release;
				yield* submission.wait;
				return current;
			}).pipe(Effect.provide(slow.layer)),
		);
		expect(during).toMatchObject({
			_tag: "InReview",
			verdict: { pass: 1, corrections: 1, outcome: { _tag: "Corrected" } },
		});
	});

	it("reads in review again when a new input is being answered, never the older answer's verdict", async () => {
		const second = held(answer("It is 56."));
		const twice = scene({ author: [answer("It is 42."), second.response], reviewer: [findings(), findings()] });
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const first = yield* state(root);
				const next = yield* root.submit({ type: "input", content: "And seven times eight?" });
				yield* second.requested;
				const during = yield* state(root);
				yield* second.release;
				yield* next.wait;
				yield* root.waitForIdle;
				return [first, during, yield* state(root)];
			}).pipe(Effect.provide(twice.layer)),
		);
		expect(states.map((each) => each._tag)).toEqual(["Reviewed", "InReview", "Reviewed"]);
		expect(states.map((each) => ("verdict" in each ? each.verdict?.pass : undefined))).toEqual([1, undefined, 1]);
	});

	it("reads held with the verdict and the waiting task, then accepted with the decision", async () => {
		const blocked = scene({
			policy: { ...POLICY, maxCorrections: 0 },
			author: [answer("It is 41.")],
			reviewer: [findings(WRONG)],
		});
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const heldState = yield* reached(root, "Held");
				yield* release(root, { _tag: "Accept", by: "user:ada" });
				yield* submission.wait;
				yield* root.waitForIdle;
				return { held: heldState, after: yield* state(root) };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(states.held).toMatchObject({
			_tag: "Held",
			task: expect.any(Number),
			verdict: { pass: 1, corrections: 0, findings: [{ check: "review.model", ...WRONG }] },
		});
		expect(states.after).toEqual({
			_tag: "Accepted",
			verdict: states.held.verdict,
			release: {
				answer: states.held.verdict.answer,
				decision: { _tag: "Accept", by: "user:ada" },
				time: expect.any(Number),
			},
		});
	});

	it("reads the hold as ended, never as reviewed, when the conversation is aborted while held", async () => {
		const blocked = scene({
			policy: { ...POLICY, maxCorrections: 0 },
			author: [answer("It is 41.")],
			reviewer: [findings(WRONG)],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const before = yield* reached(root, "Held");
				yield* root.abort();
				const settled = yield* submission.wait;
				return { before, after: yield* state(root), status: settled.status };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.after).toEqual({ _tag: "NotReviewed", reason: "hold_ended", verdict: result.before.verdict });
		// Pi's own rule for an abort after the answer: the inputs settle `done` with it. Only the state says more.
		expect(result.status).toBe("done");
	});

	it("reads an answer whose review was aborted as not reviewed for that reason, from the verdict the abort stored", async () => {
		const reading = held(findings());
		const cut = scene({ author: [answer("It is 42.")], reviewer: [reading.response] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reading.requested;
				yield* root.abort();
				const settled = yield* submission.wait;
				const stored = yield* Stream.runCollect(verdicts(root));
				return { status: settled.status, state: yield* state(root), stored: stored.map((entry) => entry.data) };
			}).pipe(Effect.provide(cut.layer)),
		);
		expect(result.stored.map((verdict) => verdict.outcome)).toEqual([
			{ _tag: "NotReviewed", reason: "review_aborted" },
		]);
		expect(result.state).toEqual({ _tag: "NotReviewed", reason: "review_aborted", verdict: result.stored[0] });
		expect(result.status).toBe("done");
	});

	it("reads an answer no review task decided about as not reviewed: another onYield hook answered first", async () => {
		const first = Extension.make({
			name: "first",
			hooks: [Hook.onYield(() => Effect.succeed(Option.some({ kind: "tasks" as const, tasks: [] })))],
		});
		const shadowed = scene({ before: [first], author: [answer("It is 42.")], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return {
					status: settled.status,
					state: yield* state(root),
					stored: yield* Stream.runCollect(verdicts(root)),
				};
			}).pipe(Effect.provide(shadowed.layer)),
		);
		expect(result).toEqual({ status: "done", state: { _tag: "NotReviewed", reason: "no_verdict" }, stored: [] });
		expect(shadowed.reviewer.state.callCount).toBe(0);
	});

	it("reads not required, never the older answer's verdict, once the conversation no longer selects the extension", async () => {
		const dropped = scene({ author: [answer("It is 42."), answer("It is 56.")], reviewer: [findings()] });
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const first = yield* state(root);
				yield* root.configure({ extensions: { remove: [NAME] } });
				yield* root.prompt("And seven times eight?");
				yield* root.waitForIdle;
				return [first, yield* state(root)];
			}).pipe(Effect.provide(dropped.layer)),
		);
		expect(states).toMatchObject([{ _tag: "Reviewed" }, { _tag: "NotRequired" }]);
		expect(states[1]).toEqual({ _tag: "NotRequired" });
		expect(dropped.reviewer.state.callCount).toBe(1);
	});

	it("reads not required for a conversation created without the extension: before it answers, while it works, and after", async () => {
		const writing = held(answer("It is 42."));
		const mixed = scene({ author: [writing.response], reviewer: [findings()] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const unreviewed = yield* Harness.createConversation({
					ownership: { kind: "ownerless" },
					agent: { model: AUTHOR, extensions: { remove: [NAME] } },
				});
				const before = yield* state(unreviewed);
				const submission = yield* unreviewed.submit({ type: "input", content: "What is six times seven?" });
				yield* writing.requested;
				const during = yield* state(unreviewed);
				yield* writing.release;
				const settled = yield* submission.wait;
				yield* unreviewed.waitForIdle;
				return {
					states: [before, during, yield* state(unreviewed)],
					status: settled.status,
					kinds: (yield* transcript(unreviewed)).map(([kind]) => kind),
					root: yield* state(yield* TestHarness.root),
				};
			}).pipe(Effect.provide(mixed.layer)),
		);
		expect(result.states).toEqual([{ _tag: "NotRequired" }, { _tag: "NotRequired" }, { _tag: "NotRequired" }]);
		// Pi ended the run with the answer, and no hook of the review was asked: no verdict, and no request.
		expect([result.status, result.kinds, mixed.reviewer.state.callCount]).toEqual([
			"done",
			["pi.user", "pi.assistant"],
			0,
		]);
		// The root still selects the extension: without an answer it is not reviewed, not exempt.
		expect(result.root).toEqual({ _tag: "NotReviewed", reason: "no_answer" });
	});

	it("reads a deferred review whose task is gone, without a verdict of its own, as not reviewed: request_failed", async () => {
		// Another hook answers first, so the answer has no verdict; the stored one names a task that never existed.
		const first = Extension.make({
			name: "first",
			hooks: [Hook.onYield(() => Effect.succeed(Option.some({ kind: "tasks" as const, tasks: [] })))],
		});
		const orphaned = scene({ before: [first], author: [answer("It is 42.")] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				const settled = yield* root.prompt("What is six times seven?");
				yield* root.waitForIdle;
				const verdict = {
					// Pi brands ids in the type system only: at run time they are the numbers.
					answer: (settled.status === "done" ? settled.answer : 0) as never,
					pass: 1,
					corrections: 0,
					...PARTIES,
					findings: [],
					failures: [
						{ check: "review.model", error: "The reviewer reviewer-lab/judge did not answer: overloaded" },
					],
					outcome: { _tag: "Deferred" as const, task: 9_999 as TaskId, attempt: 1 },
					time: 1,
				};
				yield* root.commit((tx) => tx.append(VerdictEntry, root.id, { data: verdict }));
				return { verdict, state: yield* state(root) };
			}).pipe(Effect.provide(orphaned.layer)),
		);
		expect(result.state).toEqual({ _tag: "NotReviewed", reason: "request_failed", verdict: result.verdict });
	});

	it("reads deferred with the provider's error, then in review with the deferred verdict once it is asked again", async () => {
		const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });
		const again = held(findings());
		const failing = scene({ author: [answer("It is 42.")], reviewer: [failed, again.response] });
		const states = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const deferred = yield* reached(root, "Deferred");
				yield* retry(root);
				yield* again.requested;
				const during = yield* state(root);
				yield* again.release;
				yield* submission.wait;
				yield* root.waitForIdle;
				return { deferred, during, after: yield* state(root) };
			}).pipe(Effect.provide(failing.layer)),
		);
		expect(states.deferred).toMatchObject({ _tag: "Deferred", attempt: 1, reason: "overloaded" });
		expect(states.during).toEqual({ _tag: "InReview", verdict: states.deferred.verdict });
		expect(states.after).toMatchObject({ _tag: "Reviewed", verdict: { pass: 1, outcome: { _tag: "Passed" } } });
	});

	it("reads a fork made after a hold as held by its parent's task: a release of the fork reaches the parent", async () => {
		const blocked = scene({
			policy: { ...POLICY, maxCorrections: 0 },
			author: [answer("It is 41.")],
			reviewer: [findings(WRONG)],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const parent = yield* reached(root, "Held");
				const fork = yield* root.fork({
					at: Option.getOrThrow(yield* root.head),
					ownership: { kind: "ownerless" },
				});
				const forked = yield* state(fork);
				const delivery = yield* release(fork, { _tag: "Accept", by: "user:ada" });
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { parent, forked, delivery, settled: settled.status, after: (yield* state(root))._tag };
			}).pipe(Effect.provide(blocked.layer)),
		);
		expect(result.forked).toEqual(result.parent);
		expect([result.delivery, result.settled, result.after]).toEqual(["released", "done", "Accepted"]);
	});

	it("reads a correction Pi dropped for a queued reset as not reviewed", async () => {
		const reading = held(findings(WRONG));
		const reset = scene({ author: [answer("It is 41.")], reviewer: [reading.response] });
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reading.requested;
				yield* root.reset();
				yield* reading.release;
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				return { status: settled.status, state: yield* state(root) };
			}).pipe(Effect.provide(reset.layer)),
		);
		expect(result.state).toMatchObject({
			_tag: "NotReviewed",
			reason: "correction_dropped",
			verdict: { corrections: 1, outcome: { _tag: "Corrected" } },
		});
		expect([result.status, reset.authorRequests.length]).toEqual(["done", 1]);
	});

	it("reviews the answer to a message queued during a review in its own right: the correction is dropped, the count starts over", async () => {
		const reading = held(findings(WRONG));
		const queued = scene({
			author: [answer("It is 41."), answer("It is 56.")],
			reviewer: [reading.response, findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* reading.requested;
				const next = yield* root.submit({ type: "input", content: "And seven times eight?" });
				yield* reading.release;
				yield* submission.wait;
				yield* next.wait;
				yield* root.waitForIdle;
				return { transcript: yield* transcript(root), state: yield* state(root) };
			}).pipe(Effect.provide(queued.layer)),
		);
		expect(
			result.transcript.map(([kind, data]) =>
				kind === "review.verdict" ? (data as { outcome: unknown }).outcome : data,
			),
		).toEqual([
			"What is six times seven?",
			"It is 41.",
			{ _tag: "Corrected" },
			"And seven times eight?",
			"It is 56.",
			{ _tag: "Passed" },
		]);
		expect(result.state).toMatchObject({ _tag: "Reviewed", verdict: { pass: 1, corrections: 0 } });
	});

	it("is plain data of the State schema", async () => {
		const clean = scene({ author: [answer("It is 42.")], reviewer: [findings()] });
		const read = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* submission.wait;
				yield* root.waitForIdle;
				return yield* state(root);
			}).pipe(Effect.provide(clean.layer)),
		);
		expect(Schema.decodeUnknownSync(State)(JSON.parse(JSON.stringify(read)))).toEqual(read);
	});
});

describe("verdicts", () => {
	it("streams every stored verdict, oldest first, each with its entry", async () => {
		const corrected = scene({
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* submission.wait;
				yield* root.waitForIdle;
				const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
				return {
					stored: yield* Stream.runCollect(verdicts(root)),
					transcript: yield* transcript(root),
					answers: entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.id),
				};
			}).pipe(Effect.provide(corrected.layer)),
		);
		expect(result.stored.map((entry) => [entry.kind, entry.data.pass, entry.data.outcome._tag])).toEqual([
			["review.verdict", 1, "Corrected"],
			["review.verdict", 2, "Passed"],
		]);
		// Each verdict names the entry of the answer it is about, and is the entry stored after it.
		expect(result.stored.map((entry) => entry.data.answer)).toEqual(result.answers);
		expect(result.stored.map((entry) => entry.data)).toEqual([result.transcript[2]?.[1], result.transcript[5]?.[1]]);
	});

	it("starts at an entry, so a reader that keeps where it stopped reads only what was stored since", async () => {
		const corrected = scene({
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				yield* submission.wait;
				yield* root.waitForIdle;
				const all = yield* Stream.runCollect(verdicts(root));
				const second = all[1]?.id ?? all[0]?.id;
				return {
					all,
					fromSecond: second === undefined ? [] : yield* Stream.runCollect(verdicts(root, { from: second })),
				};
			}).pipe(Effect.provide(corrected.layer)),
		);
		expect(result.all).toHaveLength(2);
		expect(result.fromSecond).toEqual([result.all[1]]);
	});
});

describe("waitOf", () => {
	it("gives the hold a verdict began, from the verdict alone: the same after a person ended it", async () => {
		const blocked = scene({
			policy: { ...POLICY, maxCorrections: 0 },
			author: [answer("It is 41.")],
			reviewer: [findings(WRONG)],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const heldState = yield* reached(root, "Held");
				yield* release(root, { _tag: "Accept", by: "user:ada" });
				yield* waitForHoldEnd(root);
				const [stored] = yield* Stream.runCollect(verdicts(root));
				return { submission: submission.id, held: heldState, after: yield* state(root), stored };
			}).pipe(Effect.provide(blocked.layer)),
		);
		// The conversation is no longer held, and its verdict still says what it was held by.
		expect(result.after._tag).toBe("Accepted");
		expect(result.stored === undefined ? Option.none() : waitOf(result.stored.data)).toEqual(
			Option.some(result.held),
		);
		// The verdict names the submission the held run answers.
		expect(result.stored?.data.inputs).toEqual([result.submission]);
	});

	it("gives a deferral as `state` read it while it lasted, and no wait for any other outcome", async () => {
		const failed = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });
		const failing = scene({
			author: [answer("It is 41."), answer("It is 42.")],
			reviewer: [failed, findings(WRONG), findings()],
		});
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* ask();
				const deferred = yield* reached(root, "Deferred");
				yield* retry(root);
				yield* submission.wait;
				yield* root.waitForIdle;
				return { deferred, stored: yield* Stream.runCollect(verdicts(root)) };
			}).pipe(Effect.provide(failing.layer)),
		);
		expect(result.stored.map((entry) => entry.data.outcome._tag)).toEqual(["Deferred", "Corrected", "Passed"]);
		expect(result.stored.map((entry) => waitOf(entry.data))).toEqual([
			Option.some(result.deferred),
			Option.none(),
			Option.none(),
		]);
	});
});
