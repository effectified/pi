import type { TaskId } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Gate, Harness, Hook } from "@effectified/pi-durable";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { approve, Digest, decide, deny, pending, RequestId } from "../src/index.ts";
import { HOUR, parked, scene, status, submit } from "./scene.ts";

const MISSING_TASK = 999_999 as TaskId;

describe("decide", () => {
	it("answers delivered, then already_decided while the call still runs, then gone once it ended", async () => {
		const { written, published, layer, hold, release, when } = scene();
		hold();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const delivered = yield* decide(request, yield* approve(request, "ada"));
				// The tool runs and is held: the call is live, and its request holds ada's approval.
				yield* when(() => written.length > 0);
				const again = yield* decide(request, yield* deny(request, "bob", "Too late."));
				yield* Effect.sync(release);
				const settled = yield* submission.wait;
				yield* root.waitForIdle;
				const late = yield* decide(request, yield* deny(request, "eve"));
				// Pi dropped the call's requests with its outcome: any id sent to it answers the same.
				const other = yield* decide(
					{ task: request.task, id: RequestId.make("never asked") },
					yield* deny(request, "eve"),
				);
				return { delivered, again, late, other, settled: settled.status };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({
			delivered: "delivered",
			again: "already_decided",
			late: "gone",
			other: "gone",
			settled: "done",
		});
		// The first decision stands: the tool ran once, on the approval.
		expect(written).toEqual(["hi"]);
	});

	it("answers gone for a call that was aborted while it waited, and the tool never runs", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				yield* root.abort();
				const late = yield* decide(request, yield* approve(request, "ada"));
				yield* root.waitForIdle;
				return { late, settled: (yield* submission.status).status, task: yield* status(request.task) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({ late: "gone", settled: "unanswered", task: "terminal" });
		expect(written).toEqual([]);
	});

	it("answers gone once the request expired, also before Pi has woken the call", async () => {
		// The host wakes this harness itself and has not yet: the call still sleeps past its expiry.
		const { written, published, layer } = scene({ harness: { hostWakes: true } });
		const seen = await runTest(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				yield* TestClock.adjust(HOUR);
				const before = yield* status(request.task);
				const late = yield* decide(request, yield* approve(request, "ada"));
				const listed = yield* pending;
				yield* root.abort();
				return { before, late, listed };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen).toEqual({ before: "sleeping", late: "gone", listed: [] });
		expect(written).toEqual([]);
	});

	it("answers superseded for a request whose call asks under a newer one, and stores nothing", async () => {
		let passes = 0;
		const Rewriter = Hook.beforeTool(() =>
			Effect.sync(() => {
				passes += 1;
				return passes === 1 ? Gate.allow : Gate.rewrite({ text: "bye" });
			}),
		);
		const { written, published, layer } = scene({ before: [Rewriter] });
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const first = yield* parked(published);
				yield* decide(first, yield* approve(first, "ada"));
				const second = yield* parked(published, 2);
				const before = yield* Harness.getTask(first.task);
				const stale = yield* decide(first, yield* deny(first, "bob"));
				const after = yield* Harness.getTask(first.task);
				yield* root.abort();
				return { first, second, stale, unchanged: JSON.stringify(before) === JSON.stringify(after) };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.stale).toBe("superseded");
		expect(seen.unchanged).toBe(true);
		expect(seen.second.id).not.toBe(seen.first.id);
		expect(written).toEqual([]);
	});

	it("answers unknown for no task, for a task that is no tool call, and for a request the call never made", async () => {
		const { published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root } = yield* submit();
				const request = yield* parked(published);
				const approval = yield* approve(request, "ada");
				const generation = (yield* Harness.inspect).tasks.find((task) => task.record.kind !== "pi.tool");
				const results = {
					noTask: yield* decide({ task: MISSING_TASK, id: request.id }, approval),
					noToolCall: yield* decide({ task: generation?.record.id as TaskId, id: request.id }, approval),
					noRequest: yield* decide(
						{ task: request.task, id: RequestId.make(`${request.task}:1:${request.digest}`) },
						approval,
					),
				};
				const listed = yield* pending;
				yield* root.abort();
				return { request, results, listed, generation: generation?.record.kind };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.results).toEqual({ noTask: "unknown", noToolCall: "unknown", noRequest: "unknown" });
		expect(seen.generation).toBe("pi.generation");
		// None of them reached the call.
		expect(seen.listed).toEqual([seen.request]);
	});

	it("fails with DigestMismatch, and delivers nothing, for a decision that names another digest", async () => {
		const { written, published, layer } = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const { root, submission } = yield* submit();
				const request = yield* parked(published);
				const error = yield* Effect.flip(
					decide(request, yield* approve({ digest: Digest.Digest.make("0".repeat(64)) }, "ada")),
				);
				const listed = yield* pending;
				// The request is still open: the right decision is delivered.
				const delivered = yield* decide(request, yield* approve(request, "ada"));
				yield* submission.wait;
				yield* root.waitForIdle;
				return { request, error, listed, delivered };
			}).pipe(Effect.provide(layer)),
		);
		expect(seen.error).toMatchObject({
			_tag: "DigestMismatch",
			request: seen.request.id,
			expected: seen.request.digest,
			actual: "0".repeat(64),
		});
		expect(seen.error.message).toBe(
			`The decision names the digest ${"0".repeat(64)}, but the request ${seen.request.id} has ${seen.request.digest}`,
		);
		expect(seen.listed).toEqual([seen.request]);
		expect(seen.delivered).toBe("delivered");
		expect(written).toEqual(["hi"]);
	});
});
