// Test helper: the review shape (review.ts) across a close and a reopen on a SQLite file, registered once per driver.
// The first harness is closed while the first review task holds its verdict in a memo and has not committed it; the
// second harness runs that phase again, which finds the memo and does not ask the reviewer a second time.

import { createExpectAssertions, type StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Effect, Layer, Option, Stream } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Harness, Storage } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";
import { correction, MODELS, review, Verdict } from "./review.ts";
import type { ClientLayer, WithDatabaseFile } from "./sqlite-suites.ts";

const INPUT = { type: "input", content: "What is six times seven?", requestId: "question" } as const;

/** Registers the suite for one driver. */
export function registerReviewReopen(
	runner: StorageConformanceRunner,
	driver: string,
	client: ClientLayer,
	withDatabaseFile: WithDatabaseFile,
): void {
	const { describe, it } = runner;
	const assert = createExpectAssertions(runner.expect);

	describe(`a review task across a reopen (${driver})`, () => {
		it("does not ask the reviewer again for a verdict it memoised, and leaves the transcript of an uninterrupted run", async () => {
			const whole = await withDatabaseFile((filename) => answered(client(filename), review()));
			const resumed = await withDatabaseFile(async (filename) => {
				const first = review({ stopAfterVerdict: true });
				await Effect.runPromise(
					Effect.gen(function* () {
						const root = yield* TestHarness.root;
						yield* root.submit(INPUT);
						yield* Effect.promise(() => first.stopped);
						// Leaving the scope closes the harness while the review task stands between its memo and its commit.
					}).pipe(Effect.provide(harness(client(filename), first))),
				);
				const second = review();
				return { first: first.requests, second: second.requests, ...(await answered(client(filename), second)) };
			});
			// The author answered once and the reviewer gave one verdict before the close.
			assert.deepEqual(resumed.first, { author: 1, reviewer: 1 });
			// After the reopen: the corrected answer and its review. The first verdict came from the memo.
			assert.deepEqual(resumed.second, { author: 1, reviewer: 1 });
			assert.deepEqual(whole.requests, { author: 2, reviewer: 2 });
			assert.deepEqual(resumed.transcript, whole.transcript);
			assert.deepEqual(resumed.transcript, [
				["pi.user", "What is six times seven?"],
				["pi.assistant", "It is 41."],
				["review.verdict", { approved: false, note: "Six times seven is 42." }],
				["pi.user", correction("Six times seven is 42.")],
				["pi.assistant", "It is 42."],
				["review.verdict", { approved: true, note: "Correct." }],
			]);
			assert.strictEqual(resumed.status, "done");
		});
	});
}

type Scenario = ReturnType<typeof review>;

function harness(client: Layer.Layer<SqlClient, SqlError>, scenario: Scenario) {
	return TestHarness.layer({
		extensions: [scenario.extension],
		responses: [scenario.model, scenario.model, scenario.model, scenario.model],
		provider: { api: "scripted", models: MODELS },
		storage: Storage.sql().pipe(Layer.provide(client), Layer.orDie),
	});
}

/** Asks the question on the database of `client`, or takes up the run a first harness left, and reads the result. */
function answered(client: Layer.Layer<SqlClient, SqlError>, scenario: Scenario) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* TestHarness.root;
			// The same request id finds the submission a first harness admitted.
			const settled = yield* (yield* root.submit(INPUT)).wait;
			yield* Harness.waitForIdle;
			const entries = yield* Stream.runCollect(root.entries({ order: "ascending" }));
			const transcript = yield* Effect.forEach(entries, (entry) =>
				Effect.map(Verdict.read(entry), (verdict) => {
					const message = entry.model?.[0];
					const text =
						message?.role === "assistant"
							? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
							: message?.role === "user"
								? message.content
								: undefined;
					return [entry.kind, Option.match(verdict, { onNone: () => text, onSome: (typed) => typed.data })];
				}),
			);
			return { status: settled.status, transcript, requests: scenario.requests };
		}).pipe(Effect.provide(harness(client, scenario))),
	);
}
