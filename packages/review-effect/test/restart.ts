// Test helper: a review across a close and a reopen of a SQLite file, registered once per SQLite driver by a platform
// test file. Every build of a scene's Layer is a new harness on the same file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, Storage } from "@gunta/pi-durable-effect";
import { answer, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Effect, Layer, Option, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { expect, it } from "vitest";
import { Check, type Finding, release, retry, state, verdicts } from "../src/index.ts";
import { ask, CALL, findings, PARTIES, POLICY, REVIEWED, reached, scene, transcript } from "./scene.ts";

/** Opens the driver's client on a database file. */
export type ClientLayer = (filename: string) => Layer.Layer<SqlClient, SqlError>;

const WRONG: Finding = { severity: "block", text: "Six times seven is 42." };

/** Registers the suite for one driver; `suite` is the runner's `describe`, or one that skips on the other runtime. */
export function registerRestart(
	suite: (name: string, body: () => void) => void,
	driver: string,
	client: ClientLayer,
): void {
	/** The scenes of one database file: the harness that starts the review, and the ones that reopen it. */
	const onFile = <A>(use: (open: typeof scene) => Promise<A>): Promise<A> =>
		withDatabaseFile((filename) => {
			const storage = Storage.sql().pipe(Layer.provide(client(filename)), Layer.orDie);
			return use((options) => scene({ ...options, storage }));
		});

	suite(`a review across a restart (${driver})`, () => {
		it("asks the reviewer once for a verdict cut off before its commit, stores it once, and grants no second correction", () =>
			onFile(async (open) => {
				// The check after the model review never answers in the first harness: the reviewer has answered, its
				// report is a memo, and the verdict is not committed when the harness closes.
				const stuck = Promise.withResolvers<void>();
				const Stuck = Check.make("app.slow", () =>
					Effect.andThen(
						Effect.sync(() => stuck.resolve()),
						Effect.never,
					),
				);
				const first = open({ checks: [Stuck], author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						yield* Effect.promise(() => stuck.promise);
						return {
							stored: yield* Stream.runCollect(verdicts(root)),
							state: yield* state(root),
							submission: (yield* submission.status).status,
						};
						// Leaving the scope closes the harness while the review task stands between its memo and its commit.
					}).pipe(Effect.provide(first.layer)),
				);
				expect(before).toEqual({ stored: [], state: { _tag: "InReview" }, submission: "placed" });
				expect([first.authorRequests.length, first.reviewer.state.callCount]).toEqual([1, 1]);

				// The second harness answers the correction wrongly again. One corrective run is allowed: it was spent.
				const Quick = Check.make("app.slow", () => Effect.succeed([]));
				const second = open({
					checks: [Quick],
					author: [answer("It is 43.")],
					reviewer: [findings(WRONG)],
				});
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						// The same request id finds the submission the first harness admitted.
						const { root, submission } = yield* ask();
						const held = yield* reached(root, "Held");
						return {
							held,
							transcript: yield* transcript(root),
							submission: (yield* submission.status).status,
						};
					}).pipe(Effect.provide(second.layer)),
				);
				const blocked = {
					...REVIEWED,
					pass: 1,
					corrections: 1,
					findings: [{ check: "review.model", ...WRONG }],
					failures: [],
					outcome: { _tag: "Corrected" },
				};
				expect(after.transcript).toEqual([
					["pi.user", "What is six times seven?"],
					["pi.assistant", "It is 41."],
					// Stored once, from the memo: the first harness's reviewer answered it.
					["review.verdict", blocked],
					["pi.user", expect.stringContaining("1. [block] Six times seven is 42.")],
					["pi.assistant", "It is 43."],
					["review.verdict", { ...blocked, pass: 2, outcome: { _tag: "Held", task: after.held.task } }],
				]);
				// After the reopen: one corrective answer and its one review. The first verdict cost no second request.
				expect([second.authorRequests.length, second.reviewer.state.callCount]).toEqual([1, 1]);
				expect(after.submission).toBe("placed");
			}));

		it("is still held after a reopen, takes a decision while nothing runs, and applies it once at the next open", () =>
			onFile(async (open) => {
				const strict = { ...POLICY, maxCorrections: 0 };
				const first = open({ policy: strict, author: [answer("It is 41.")], reviewer: [findings(WRONG)] });
				const before = await Effect.runPromise(
					Effect.gen(function* () {
						const { root } = yield* ask();
						return yield* reached(root, "Held");
					}).pipe(Effect.provide(first.layer)),
				);

				// Reopened with scheduling on: still held, by the same task, and nobody is asked again.
				const second = open({ policy: strict });
				const reopened = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						// Time for the scheduler to take up whatever the first harness left: nothing.
						yield* Effect.sleep("30 millis");
						const task = Option.getOrThrow(yield* Harness.getTask(before.task));
						return {
							state: yield* state(root),
							task: task.state.status,
							submission: (yield* submission.status).status,
						};
					}).pipe(Effect.provide(second.layer)),
				);
				expect(reopened).toEqual({ state: before, task: "sleeping", submission: "placed" });
				expect([second.authorRequests.length, second.reviewer.state.callCount]).toEqual([0, 0]);

				// Open without scheduling: the least a host needs to take a person's decision. A second one changes nothing.
				const paused = open({ policy: strict, paused: true });
				const decided = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						const delivery = yield* release(root, { _tag: "Accept", by: "user:ada" });
						const again = yield* release(root, {
							_tag: "Correct",
							by: "user:bob",
							correction: "Multiply again.",
						});
						return { delivery, again, state: yield* state(root) };
					}).pipe(Effect.provide(paused.layer)),
				);
				// Durably decided, and not applied yet: the state says so, with the first decision.
				expect(decided).toEqual({
					delivery: "released",
					again: "already_released",
					state: {
						_tag: "Released",
						verdict: before.verdict,
						task: before.task,
						decision: { _tag: "Accept", by: "user:ada" },
					},
				});

				const third = open({ policy: strict });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						return { settled: settled.status, state: yield* state(root), transcript: yield* transcript(root) };
					}).pipe(Effect.provide(third.layer)),
				);
				const decision = {
					answer: before.verdict.answer,
					decision: { _tag: "Accept", by: "user:ada" },
					time: expect.any(Number),
				};
				expect(after.settled).toBe("done");
				expect(after.state).toEqual({ _tag: "Accepted", verdict: before.verdict, release: decision });
				expect(after.transcript).toEqual([
					["pi.user", "What is six times seven?"],
					["pi.assistant", "It is 41."],
					["review.verdict", before.verdict],
					["review.release", decision],
				]);
				expect([third.authorRequests.length, third.reviewer.state.callCount]).toEqual([0, 0]);
			}));
	});

	suite(`a deferred review across a restart (${driver})`, () => {
		const FAILED = fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" });
		const failure = {
			answer: expect.any(Number),
			pass: 1,
			corrections: 0,
			...PARTIES,
			call: { ...CALL, stopReason: "error", error: "overloaded" },
			findings: [],
			failures: [{ check: "review.model", error: "The reviewer reviewer-lab/judge did not answer: overloaded" }],
			time: expect.any(Number),
		};

		/** The first harness: the reviewer's provider fails once, and the harness closes with the review deferred. */
		const deferredIn = (open: typeof scene) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const { root, submission } = yield* ask();
					const deferred = yield* reached(root, "Deferred");
					return { deferred, submission: (yield* submission.status).status };
				}).pipe(Effect.provide(open({ author: [answer("It is 41.")], reviewer: [FAILED] }).layer)),
			);

		it("says so after a reopen, takes the retry while nothing runs, and passes the answer at the next open", () =>
			onFile(async (open) => {
				const before = await deferredIn(open);
				expect(before.deferred).toEqual({
					_tag: "Deferred",
					verdict: { ...failure, outcome: { _tag: "Deferred", task: before.deferred.task, attempt: 1 } },
					task: expect.any(Number),
					attempt: 1,
					reason: "overloaded",
				});
				expect(before.submission).toBe("placed");

				// Reopened with scheduling on: the same state, read from the storage, and nobody is asked.
				const second = open({ reviewer: [findings()] });
				const reopened = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						yield* Effect.sleep("30 millis");
						const task = Option.getOrThrow(yield* Harness.getTask(before.deferred.task));
						return {
							state: yield* state(root),
							task: task.state.status,
							submission: (yield* submission.status).status,
						};
					}).pipe(Effect.provide(second.layer)),
				);
				expect(reopened).toEqual({ state: before.deferred, task: "sleeping", submission: "placed" });
				expect([second.authorRequests.length, second.reviewer.state.callCount]).toEqual([0, 0]);

				// Open without scheduling: the retry is taken, durably, and nothing runs. A second one changes nothing.
				const paused = open({ paused: true });
				const asked = await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						return { first: yield* retry(root), again: yield* retry(root), state: yield* state(root) };
					}).pipe(Effect.provide(paused.layer)),
				);
				expect(asked).toEqual({
					first: "retrying",
					again: "already_retrying",
					state: { _tag: "InReview", verdict: before.deferred.verdict },
				});

				const third = open({ reviewer: [findings()] });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						return { settled: settled.status, state: yield* state(root), transcript: yield* transcript(root) };
					}).pipe(Effect.provide(third.layer)),
				);
				const passed = {
					...REVIEWED,
					pass: 1,
					corrections: 0,
					findings: [],
					failures: [],
					outcome: { _tag: "Passed" },
				};
				expect(after.settled).toBe("done");
				expect(after.state).toEqual({ _tag: "Reviewed", verdict: passed });
				expect(after.transcript).toEqual([
					["pi.user", "What is six times seven?"],
					["pi.assistant", "It is 41."],
					["review.verdict", before.deferred.verdict],
					["review.verdict", passed],
				]);
				// One request to the reviewer after the reopen, and none to the author.
				expect([third.authorRequests.length, third.reviewer.state.callCount]).toEqual([0, 1]);
			}));

		it("blocks the answer at the later review, as scripted: the run is corrected after the reopen", () =>
			onFile(async (open) => {
				const before = await deferredIn(open);
				const second = open({ author: [answer("It is 42.")], reviewer: [findings(WRONG), findings()] });
				const after = await Effect.runPromise(
					Effect.gen(function* () {
						const { root, submission } = yield* ask();
						const found = yield* state(root);
						const asked = yield* retry(root);
						const settled = yield* submission.wait;
						yield* root.waitForIdle;
						const stored = yield* Stream.runCollect(verdicts(root));
						return {
							found,
							asked,
							settled: settled.status,
							state: yield* state(root),
							stored: stored.map((entry) => [entry.data.pass, entry.data.corrections, entry.data.outcome._tag]),
							transcript: yield* transcript(root),
						};
					}).pipe(Effect.provide(second.layer)),
				);
				expect(after.found).toEqual(before.deferred);
				expect([after.asked, after.settled]).toEqual(["retrying", "done"]);
				expect(after.stored).toEqual([
					[1, 0, "Deferred"],
					[1, 1, "Corrected"],
					[2, 1, "Passed"],
				]);
				expect(after.transcript.map(([kind, data]) => (typeof data === "string" ? data : kind))).toEqual([
					"What is six times seven?",
					"It is 41.",
					"review.verdict",
					"review.verdict",
					expect.stringContaining("1. [block] Six times seven is 42."),
					"It is 42.",
					"review.verdict",
				]);
				expect(after.state).toMatchObject({ _tag: "Reviewed", verdict: { pass: 2, corrections: 1 } });
				expect([second.authorRequests.length, second.reviewer.state.callCount]).toEqual([1, 2]);
			}));
	});
}

/** Runs `use` with the path of a database file in a fresh temporary directory, removed afterwards. */
async function withDatabaseFile<A>(use: (filename: string) => Promise<A>): Promise<A> {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-effect-"));
	try {
		return await use(join(directory, "storage.sqlite"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
