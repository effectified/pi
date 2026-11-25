import type { SubmissionId } from "@earendil-works/pi-durable";
import { runTest } from "@gunta/pi-ai-effect/testing";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Harness, Submission } from "../src/index.ts";
import { runBoth } from "./parity.ts";
import { AGENT, answer, harnessLayer, heldAnswer, scriptedModels } from "./scripted.ts";

describe("parity with Pi Durable", () => {
	it("status and wait follow a submission from placed to done", async () => {
		let held = heldAnswer("Done.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Done.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				const placed = yield* submission.status;
				held.release();
				return { placed, settled: yield* submission.wait, after: yield* submission.status };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const submission = await root.submit({ type: "input", content: "Go.", requestId: "a" }, context);
				await held.requested;
				const placed = await submission.status(context);
				held.release();
				return { placed, settled: await submission.wait(context), after: await submission.status(context) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		const { placed, settled, after } = both.effect.result as Record<string, { status: string }>;
		expect(placed.status).toBe("placed");
		expect(settled.status).toBe("done");
		expect(after).toEqual(settled);
	});

	it("abort withdraws a queued submission and leaves a placed one", async () => {
		let held = heldAnswer("Done.");
		const both = await runBoth({
			responses: () => {
				held = heldAnswer("Done.");
				return [held.response];
			},
			effect: Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const first = yield* root.submit({ type: "input", content: "Long task.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				const second = yield* root.submit({ type: "input", content: "Also this.", requestId: "b" });
				const results = { queued: yield* second.abort, placed: yield* first.abort, again: yield* second.abort };
				held.release();
				return { ...results, second: yield* second.status };
			}),
			pi: async (harness, context) => {
				const root = await harness.root(context, { agent: AGENT });
				const first = await root.submit({ type: "input", content: "Long task.", requestId: "a" }, context);
				await held.requested;
				const second = await root.submit({ type: "input", content: "Also this.", requestId: "b" }, context);
				const results = {
					queued: await second.abort(context),
					placed: await first.abort(context),
					again: await second.abort(context),
				};
				held.release();
				return { ...results, second: await second.status(context) };
			},
		});
		expect(both.effect).toEqual(both.pi);
		expect(both.effect.result).toMatchObject({
			queued: "aborted",
			placed: "already_placed",
			again: "settled",
			second: { status: "unanswered", reason: "aborted" },
		});
		expect(both.effect.records.submissions.map((submission) => submission.status)).toEqual(["done", "unanswered"]);
	});
});

describe("interruption", () => {
	it("interrupting wait cancels only the wait: the run still completes", async () => {
		const held = heldAnswer("Done.");
		const scripted = scriptedModels([held.response, answer("Unused.")]);
		const result = await runTest(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "a" });
				yield* Effect.promise(() => held.requested);
				// Started at once, the wait has asked Pi when its fork returns.
				const waiting = yield* Effect.forkChild(submission.wait, { startImmediately: true });
				yield* Fiber.interrupt(waiting);
				const exit = yield* Fiber.await(waiting);
				const whileHeld = yield* submission.status;
				held.release();
				return { exit, whileHeld, settled: yield* submission.wait };
			}).pipe(Effect.provide(harnessLayer({ models: scripted.layer }))),
		);
		expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
		expect(result.whileHeld.status).toBe("placed");
		expect(result.settled).toMatchObject({ status: "done", requestId: "a" });
		expect(scripted.faux.state.callCount).toBe(1);
	});
});

describe("settled", () => {
	it("holds for done and unanswered, the statuses of Pi's settled record, and not for queued or placed", () => {
		const statuses = ["queued", "placed", "done", "unanswered"] as const;
		expect(statuses.filter(Submission.settled)).toEqual(["done", "unanswered"]);
	});

	it("agrees with what a submission's wait settles with", async () => {
		const settled = await Effect.runPromise(
			Effect.gen(function* () {
				const root = yield* Harness.rootWith({ agent: AGENT });
				const submission = yield* root.submit({ type: "input", content: "Go." });
				const open = Submission.settled((yield* submission.status).status);
				const record = yield* submission.wait;
				return { open, settled: Submission.settled(record.status) };
			}).pipe(Effect.provide(harnessLayer({ responses: [answer("Done.")] }))),
		);
		expect(settled).toEqual({ open: false, settled: true });
	});
});

describe("Id", () => {
	it("is a number in stored JSON and a submission id in the decoded value", async () => {
		const Kept = Schema.Struct({ inputs: Schema.Array(Submission.Id) });
		const typed: Equal<(typeof Kept)["Type"]["inputs"], ReadonlyArray<SubmissionId>> = true;
		const stored: Equal<(typeof Kept)["Encoded"]["inputs"], ReadonlyArray<number>> = true;
		const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.toCodecJson(Kept))({ inputs: [3, 4] }));
		expect([typed, stored]).toEqual([true, true]);
		expect(decoded).toEqual({ inputs: [3, 4] });
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
