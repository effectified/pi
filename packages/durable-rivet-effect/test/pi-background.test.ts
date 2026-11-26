// What the status action counts of Pi's own background work: an automatic compaction is a background task of Pi,
// started while a conversation's context passes the background threshold, and it holds a model request. The status
// must count it as live work and not as a background task of the product, so `Client.fork` refuses to copy it in
// flight. A new background task of Pi's, or a compaction Pi stops marking background, fails here.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CompactionTask } from "@earendil-works/pi-durable";
import { runTest } from "@effectified/pi-ai/testing";
import { Harness } from "@effectified/pi-durable";
import { answer, TestHarness } from "@effectified/pi-durable/testing";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Protocol from "../src/protocol.ts";
import * as WakeKeeper from "../src/wake-keeper.ts";

/** An actor's schedule that keeps nothing: the status action only asks the keeper to settle. */
const noAlarm: WakeKeeper.Alarm = {
	schedule: () => Effect.succeed("wake"),
	cancel: () => Effect.void,
	scheduled: Effect.succeed([]),
	stayAwake: Effect.void,
	letSleep: Effect.void,
};

/** The status the action answers, decoded as a caller decodes it. */
const status = Effect.gen(function* () {
	const answer = yield* Protocol.status.run(null);
	if (answer._tag !== "success") return yield* Effect.die(new Error(`status answered ${answer._tag}`));
	return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Protocol.Status))(answer.value);
});

describe("the status action and Pi's background work", () => {
	it("counts an automatic compaction as live work and not as a background task of the product", async () => {
		// The summary request of the compaction is held until the test has read the status.
		const summarizing = Promise.withResolvers<void>();
		const summarized = Promise.withResolvers<void>();
		const summary = async (): Promise<AssistantMessage> => {
			summarizing.resolve();
			await summarized.promise;
			return answer("They talked.") as AssistantMessage;
		};
		const live = WakeKeeper.layer(noAlarm).pipe(
			Layer.provideMerge(
				TestHarness.layer({
					responses: [answer("First."), answer("Second."), summary],
					harness: {
						hostWakes: true,
						// The background threshold is one token below a context window of 128,000 tokens with no reserve:
						// the second request passes it, and keeping one token verbatim leaves a range to summarize.
						settings: {
							compaction: { enabled: true, reserveTokens: 0, backgroundTokens: 127_999, keepRecentTokens: 1 },
						},
					},
				}),
			),
		);
		const seen = await runTest(
			Effect.gen(function* () {
				const root = yield* TestHarness.root;
				yield* root.prompt("One.");
				yield* root.waitForIdle;
				yield* root.prompt("Two.");
				yield* Effect.promise(() => summarizing.promise);
				const { tasks } = yield* Effect.orDie(Harness.inspect);
				const during = yield* status;
				summarized.resolve();
				// A background task does not hold the conversation's idle: the compaction is awaited by its own id.
				for (const { record } of tasks) if (record.background) yield* Harness.waitForTask(record.id);
				yield* root.waitForIdle;
				return {
					records: tasks.map(({ record }) => ({ kind: record.kind, background: record.background })),
					during,
					after: yield* status,
				};
			}).pipe(Effect.provide(live)),
		);
		// Pi's automatic compaction is a background task of the kind `CompactionTask` names.
		expect(seen.records).toContainEqual({ kind: CompactionTask.definition.name, background: true });
		// Every live background task is Pi's compaction, and the status counts none of them as the product's.
		expect(seen.records.filter(({ background }) => background)).toEqual([
			{ kind: CompactionTask.definition.name, background: true },
		]);
		expect(seen.during.tasks).toBeGreaterThan(0);
		expect(seen.during.background).toBe(0);
		expect(seen.after).toMatchObject({ tasks: 0, background: 0, submissions: 0 });
	});
});
