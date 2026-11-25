// Test helper: the shape of a review plugin, used on memory (hook-task.test.ts) and across a reopen on a SQLite file
// (review-reopen.ts). An `onYield` hook asks for a task; the task asks a second model for a verdict, keeps it in a
// memo, writes it as an entry in its own commit, and completes with a `YieldDecision`: the answer stands, or the run
// continues with a correction.

import type { AssistantMessage, FauxResponseFactory, Models } from "@earendil-works/pi-ai";
import { Effect, Option, Schema } from "effect";
import { Entry, Extension, Hook, Task } from "../src/index.ts";
import { answer } from "../src/testing/index.ts";

/** The author's and the reviewer's model, of one scripted provider. */
export const MODELS = [{ id: "author" }, { id: "reviewer" }];

const VerdictData = Schema.Struct({ approved: Schema.Boolean, note: Schema.String });

/** The reviewer's verdict on one answer, as an entry of the reviewed conversation. */
export const Verdict = Entry.make("review.verdict", VerdictData);

/** What the reviewer tells the author when it objects. */
export const correction = (note: string) => `A reviewer objected: ${note} Correct your answer.`;

const textOf = (message: AssistantMessage) =>
	message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/**
 * One harness's worth of the scenario: the extension, the scripted model, and what it counted. The author first
 * answers 41 and, once corrected, 42; the reviewer approves an answer that says 42. `stopAfterVerdict` holds the
 * first review task after its verdict is memoised and before it commits, until the closing harness interrupts it.
 */
export function review(options: { readonly stopAfterVerdict?: boolean } = {}) {
	const requests = { author: 0, reviewer: 0 };
	const stopped = Promise.withResolvers<void>();
	const model: FauxResponseFactory = (context, _options, _state, asked) => {
		if (asked.id === "reviewer") {
			requests.reviewer += 1;
			const approved = JSON.stringify(context.messages).includes("It is 42.");
			return answer(JSON.stringify({ approved, note: approved ? "Correct." : "Six times seven is 42." }));
		}
		requests.author += 1;
		const corrected = JSON.stringify(context.messages).includes("A reviewer objected");
		return answer(corrected ? "It is 42." : "It is 41.");
	};
	const Review = Task.make({
		name: "review.review",
		version: 1,
		input: Schema.Struct({ answer: Schema.String }),
		state: Schema.Struct({ phase: Schema.Literal("review") }),
		result: Hook.YieldDecision,
		initial: () => ({ phase: "review" as const }),
		phases: {
			review: (task, api) =>
				Effect.gen(function* () {
					// The verdict is a memo: a phase that runs again after a close or a crash does not ask the model twice.
					const kept = yield* api.memo<typeof VerdictData.Encoded>("review.verdict");
					const verdict = Option.isSome(kept)
						? kept.value
						: yield* Effect.flatMap(ask(task.input.answer, api.pi.models, yield* api.now), (given) =>
								api.memo("review.verdict", given),
							);
					if (options.stopAfterVerdict === true) {
						stopped.resolve();
						yield* Effect.never;
					}
					// The verdict entry and the task's decision are stored together.
					return yield* api.commit((tx) =>
						Effect.as(
							tx.append(Verdict, api.conversationId, { data: verdict }),
							Task.complete(verdict.approved ? Hook.stand : Hook.continueWith(correction(verdict.note))),
						),
					);
				}),
		},
		abort: () => Effect.succeed(Task.aborted()),
	});
	const extension = Extension.make({
		name: "review",
		tasks: [Review],
		hooks: [
			Hook.onYield((answered) =>
				Effect.map(Hook.task(Review, { answer: textOf(answered) }), (request) =>
					Option.some({ kind: "tasks" as const, tasks: [request] }),
				),
			),
		],
	});
	return { extension, model, requests, stopped: stopped.promise, Review };
}

/** Asks the reviewer model for its verdict on `text`, through the models Pi gives the task (`api.pi.models`). */
function ask(text: string, models: Models, timestamp: number) {
	return Effect.gen(function* () {
		const reviewer = Option.getOrThrow(Option.fromUndefinedOr(models.getModel("faux", "reviewer")));
		const reply = yield* Effect.promise((signal) =>
			models.completeSimple(
				reviewer,
				{ messages: [{ role: "user", content: `Review this answer: ${text}`, timestamp }] },
				{ signal },
			),
		);
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(VerdictData))(textOf(reply));
	});
}
