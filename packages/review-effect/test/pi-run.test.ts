// `Run.view` on what a real harness stores, not on a hand-built live document: a run whose `afterRun` hook is
// selected has answered and settled its inputs, yet keeps Pi's `run` while the hook and its tasks are pending. The
// view reads that run as not working, as `Run.view` documents; a Pi that marks such a run otherwise fails here.

import { runTest } from "@gunta/pi-ai-effect/testing";
import { BuiltinDoc, type Conversation, Extension, Harness, Hook } from "@gunta/pi-durable-effect";
import { answer, held, TestHarness } from "@gunta/pi-durable-effect/testing";
import { Deferred, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import * as Run from "../src/run.ts";

/** What a review reads of `conversation`'s run, as `state` reads it, and whether Pi keeps a run at all. */
const read = (conversation: Conversation.Conversation) =>
	Effect.map(Harness.snapshot(BuiltinDoc.live, conversation.id), (live) => ({
		working: Run.view(live).working,
		inputs: Run.view(live).inputs.length,
		kept: Option.getOrUndefined(live)?.run !== undefined,
	}));

describe("Run.view on a real harness", () => {
	it("reads a run as working while it writes, and not working while only its afterRun hook is pending", () =>
		runTest(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const leave = yield* Deferred.make<void>();
				const after = Hook.afterRun(() =>
					Effect.andThen(Deferred.succeed(entered, undefined), Effect.as(Deferred.await(leave), Option.none())),
				);
				const writing = held(answer("It is 42."));
				const seen = yield* Effect.gen(function* () {
					const root = yield* TestHarness.root;
					const submission = yield* root.submit({ type: "input", content: "Six times seven?" });
					yield* writing.requested;
					const whileWriting = yield* read(root);
					yield* writing.release;
					yield* Deferred.await(entered);
					const whileAfterRun = yield* read(root);
					const settled = yield* submission.wait;
					yield* Deferred.succeed(leave, undefined);
					yield* root.waitForIdle;
					return { whileWriting, whileAfterRun, settled: settled.status, ended: yield* read(root) };
				}).pipe(
					Effect.provide(
						TestHarness.layer({
							extensions: [Extension.make({ name: "app", hooks: [after] })],
							responses: [writing.response],
						}),
					),
				);
				expect(seen.whileWriting).toEqual({ working: true, inputs: 1, kept: true });
				// Pi keeps the run, with no inputs, while the hook runs: the answer stands and the input is settled.
				expect(seen.whileAfterRun).toEqual({ working: false, inputs: 0, kept: true });
				expect(seen.settled).toBe("done");
				expect(seen.ended).toEqual({ working: false, inputs: 0, kept: false });
			}),
		));
});
