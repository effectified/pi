// Test helper: one harness closed while a model request is pending, then a second harness on the same storage.

import type { SubmissionRecord } from "@earendil-works/pi-durable";
import { Effect, type Layer, Option } from "effect";
import { type DurableError, Harness, type Storage, type Submission } from "../src/index.ts";
import { AGENT, answer, harnessLayer, heldAnswer, scriptedModels } from "./scripted.ts";

/**
 * Submits an input whose answer the model holds back, closes the harness, and reopens one on `storage` (a Layer that
 * opens the same stored data each time it is built) with a model that answers. Returns the submission's record some
 * time after the reopen without asking for progress (`unprompted`), its record after waiting for idle (`settled`),
 * and how often each model was asked.
 */
export async function reopenWithPendingSubmission(
	storage: Layer.Layer<Storage.HarnessStorage>,
	options: Harness.Options,
) {
	const held = heldAnswer("Never given.");
	const first = scriptedModels([held.response]);
	const id = await Effect.runPromise(
		Effect.gen(function* () {
			const root = yield* Harness.rootWith({ agent: AGENT });
			const submission = yield* root.submit({ type: "input", content: "Go.", requestId: "pending" });
			yield* Effect.promise(() => held.requested);
			return submission.id;
		}).pipe(Effect.provide(harnessLayer({ models: first.layer, storage }))),
	);

	const second = scriptedModels([answer("Done after reopen.")]);
	const reopened = await Effect.runPromise(
		Effect.gen(function* () {
			const submission = Option.getOrThrow(yield* Harness.submission(id));
			// Reading a status never starts scheduling, so only `resume()` at open can have continued the run.
			const unprompted = yield* statusAfter(submission, 20);
			yield* Harness.waitForIdle;
			return { unprompted, settled: yield* submission.status };
		}).pipe(Effect.provide(harnessLayer({ models: second.layer, storage, harness: options }))),
	);
	return { ...reopened, firstCalls: first.faux.state.callCount, secondCalls: second.faux.state.callCount };
}

/** The submission's record once it is settled, or after `attempts` reads five milliseconds apart. */
function statusAfter(
	submission: Submission.Submission,
	attempts: number,
): Effect.Effect<SubmissionRecord, DurableError> {
	return Effect.flatMap(submission.status, (record) =>
		attempts === 0 || record.status === "done" || record.status === "unanswered"
			? Effect.succeed(record)
			: Effect.andThen(
					Effect.sleep("5 millis"),
					Effect.suspend(() => statusAfter(submission, attempts - 1)),
				),
	);
}
