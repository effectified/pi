// Test helper: one harness closed while a model request is pending, then a second harness on the same storage.

import type { SubmissionRecord } from "@earendil-works/pi-durable";
import { runLive } from "@effectified/pi-ai/testing";
import { Effect, Fiber, type Layer, Option, Stream } from "effect";
import { type DurableError, Harness, type Storage, type Submission } from "../src/index.ts";
import { AGENT, answer, harnessLayer, heldAnswer, scriptedModels } from "./scripted.ts";

/**
 * Submits an input whose answer the model holds back, closes the harness, and reopens one on `storage` (a Layer that
 * opens the same stored data each time it is built) with a model that answers. Returns the submission's record after
 * the reopen without asking for progress (`unprompted`, see `unpromptedRecord`), its record after waiting for idle
 * (`settled`), and how often each model was asked. On the live clock: `storage` may be a file.
 */
export async function reopenWithPendingSubmission(
	storage: Layer.Layer<Storage.HarnessStorage>,
	options: Harness.Options,
) {
	const held = heldAnswer("Never given.");
	const first = scriptedModels([held.response]);
	const id = await runLive(
		Effect.gen(function* () {
			const root = yield* Harness.rootWith({ agent: AGENT });
			const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "pending" });
			yield* Effect.promise(() => held.requested);
			return submission.id;
		}).pipe(Effect.provide(harnessLayer({ models: first.layer, storage }))),
	);

	const second = scriptedModels([answer("Done after reopen.")]);
	const reopened = await runLive(
		Effect.gen(function* () {
			const submission = Option.getOrThrow(yield* Harness.submission(id));
			// Reading a status never starts scheduling, so only `resume()` at open can have continued the run.
			const unprompted = yield* unpromptedRecord(submission);
			yield* Harness.waitForIdle;
			return { unprompted, settled: yield* submission.status };
		}).pipe(Effect.provide(harnessLayer({ models: second.layer, storage, harness: options }))),
	);
	return { ...reopened, firstCalls: first.faux.state.callCount, secondCalls: second.faux.state.callCount };
}

/**
 * The submission's record as it ends up without anyone asking Pi for progress: now, when it is settled or Pi's
 * scheduling is paused, so that nothing continues it; otherwise once a stored commit settles it, read from the commit
 * stream, which asks Pi for nothing.
 */
function unpromptedRecord(
	submission: Submission.Submission,
): Effect.Effect<SubmissionRecord, DurableError, Harness.Harness> {
	return Effect.gen(function* () {
		// Attached before the status is read, so the commit that settles it cannot fall between the two.
		const settling = yield* Effect.forkChild(
			Stream.runHead(
				Stream.filter(Harness.commits, (commit) =>
					commit.changes.some(
						(change) =>
							change.type === "submission" && change.value.id === submission.id && settled(change.value),
					),
				),
			),
			{ startImmediately: true },
		);
		const now = yield* submission.status;
		if (settled(now) || (yield* Harness.inspect).scheduling === "paused") {
			yield* Fiber.interrupt(settling);
			return now;
		}
		yield* Fiber.join(settling);
		return yield* submission.status;
	});
}

function settled(record: SubmissionRecord): boolean {
	return record.status === "done" || record.status === "unanswered";
}
