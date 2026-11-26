import type { Usage } from "@earendil-works/pi-ai";
import { runTest } from "@effectified/pi-ai/testing";
import { type Conversation, Extension, Harness, Registry, Tool } from "@effectified/pi-durable";
import { answer, held, ScriptedModels, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { continueStopped, refusalOf, stopOf } from "../src/index.ts";
import {
	type Budgeted,
	budgetedHarness,
	ESTIMATE,
	expectedCost,
	root as rootConversation,
	TestLease,
} from "./support.ts";

/** What a test does when the model's tool call runs: between the first request of a run and the second. */
const duringTool = { run: () => {} };

const Lookup = Tool.make("lookup", {
	description: "Look a record up by id.",
	parameters: Schema.Struct({ id: Schema.String }),
	success: Schema.Struct({ title: Schema.String }),
	replay: "safe",
	handler: () =>
		Effect.sync(() => {
			duringTool.run();
			return { title: "Answer" };
		}),
});

const App = Extension.make({ name: "app", tools: [Lookup] });

/** Pi's attempt retries are on, with no wait to speak of: a refusal must end the run all the same. */
const RETRYING = { settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } };

/** The budgeted harness of this file, with `App` and Pi's retries on. */
const harness = () => budgetedHarness({ registry: Layer.orDie(Registry.layer([App])), harness: RETRYING });

const run = <A, E>(body: Effect.Effect<A, E, Harness.Harness | Budgeted>) =>
	Effect.runPromise(Effect.provide(body, harness()));

/** The kinds of a conversation's entries, oldest first, and for each assistant entry how it ended. */
const transcript = (conversation: Conversation.Conversation) =>
	Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.map((entry) => {
			const [message] = entry.model ?? [];
			return message?.role === "assistant" ? `${entry.kind}:${message.stopReason}` : entry.kind;
		}),
	);

/** The usage Pi stored with each assistant entry, oldest first. */
const storedUsage = (conversation: Conversation.Conversation) =>
	Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.flatMap((entry): Usage[] => {
			const [message] = entry.model ?? [];
			return message?.role === "assistant" ? [message.usage] : [];
		}),
	);

describe("a run on a live lease", () => {
	it("reserves and settles once per model request: twice for a turn with a tool call", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				duringTool.run = () => {};
				yield* scripted.setResponses([toolCall("lookup", { id: "42" }), answer("It is called Answer.")]);
				const root = yield* rootConversation;
				const settled = yield* root.prompt("What is record 42 called?");
				expect(settled.status).toBe("done");
				expect(yield* scripted.callCount).toBe(2);
				expect(lease.steps.map((step) => `${step.step}:${"token" in step ? step.token : ""}`)).toEqual([
					"reserve:r1",
					"settle:r1",
					"reserve:r2",
					"settle:r2",
				]);
				const [first, second] = yield* storedUsage(root);
				if (first === undefined || second === undefined) throw new Error("two assistant entries expected");
				const usages = [first, second].map(({ input, output, cacheRead, cacheWrite }) => ({
					input,
					output,
					cacheRead,
					cacheWrite,
				}));
				expect(lease.steps.flatMap((step) => (step.step === "settle" ? [step.settlement] : []))).toEqual([
					{ usage: usages[0], cost: expectedCost(first), outcome: "returned" },
					{ usage: usages[1], cost: expectedCost(second), outcome: "returned" },
				]);
				expect(expectedCost(first)).toBeGreaterThan(0n);
				// Both requests carry the conversation's provider session, and a digest of what each asks: nothing else
				// of it. The second asks more than the first, so its key is another.
				const requests = lease.steps.flatMap((step) => (step.step === "reserve" ? [step] : []));
				expect(requests.map(({ estimate }) => estimate)).toEqual([ESTIMATE, ESTIMATE]);
				expect(requests[0]?.request).toEqual({
					kind: "chat",
					provider: scripted.model.provider,
					model: scripted.model.id,
					session: requests[0]?.request.session,
					requestKey: expect.stringMatching(/^[0-9a-f]{64}$/),
				});
				expect(requests[0]?.request.session).toMatch(/^[0-9a-f-]{36}$/);
				expect(requests[1]?.request.session).toBe(requests[0]?.request.session);
				expect(requests[1]?.request.requestKey).toMatch(/^[0-9a-f]{64}$/);
				expect(requests[1]?.request.requestKey).not.toBe(requests[0]?.request.requestKey);
				expect(yield* stopOf(root.id)).toEqual(Option.none());
			}),
		));

	it("covers the request of a compaction", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				yield* scripted.setResponses([
					answer("Hello there, how are you today?"),
					answer("They greeted each other."),
				]);
				const root = yield* rootConversation;
				yield* root.prompt("Hello");
				yield* Harness.waitForTask(yield* root.compact());
				expect(yield* scripted.callCount).toBe(2);
				expect(lease.steps.map((step) => `${step.step}:${"token" in step ? step.token : ""}`)).toEqual([
					"reserve:r1",
					"settle:r1",
					"reserve:r2",
					"settle:r2",
				]);
				expect(lease.steps[3]).toMatchObject({ settlement: { outcome: "returned" } });
				expect((yield* transcript(root)).at(-1)).toBe("pi.compaction");
			}).pipe(
				Effect.provide(
					// Keeps one token verbatim, so a manual compaction of this short transcript finds a range to summarize.
					budgetedHarness({ harness: { settings: { compaction: { enabled: false, keepRecentTokens: 1 } } } }),
				),
			),
		));
});

describe("a run that is aborted", () => {
	it("settles the request in flight as aborted", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				const waiting = held(answer("Never."));
				yield* scripted.setResponses([waiting.response]);
				const root = yield* rootConversation;
				const input = yield* root.submit({ type: "input", content: "Hello" });
				yield* waiting.requested;
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve"]);
				yield* root.abort();
				expect(yield* input.wait).toMatchObject({ status: "unanswered", reason: "aborted" });
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle"]);
				expect(lease.steps[1]).toMatchObject({ token: "r1", settlement: { outcome: "aborted" } });
				// An abort is Pi's own stop, not the budget's.
				expect(yield* stopOf(root.id)).toEqual(Option.none());
			}),
		));
});

describe("a run on a fenced lease", () => {
	it("stops with a typed reason, is not retried, loses nothing, and answers when continued", () =>
		runTest(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				// The lease is fenced while the tool runs: the run's second request finds it gone.
				duringTool.run = () => {
					lease.fenced = "expired";
				};
				yield* scripted.setResponses([toolCall("lookup", { id: "42" }), answer("It is called Answer.")]);
				const root = yield* rootConversation;
				const settled = yield* root.prompt("What is record 42 called?");

				// The run failed durably: its input is unanswered, with the refusal in the detail Pi stored.
				expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
				const fenced = Option.getOrThrow(yield* refusalOf(settled.detail));
				expect(fenced).toMatchObject({ _tag: "LeaseFenced", reason: "expired" });
				expect(yield* stopOf(root.id)).toEqual(Option.some({ refusal: fenced, inputs: [settled.id] }));

				// Nothing was retried on the dead lease: one refused reservation, and the provider saw one request.
				// An hour passes Pi's every retry delay.
				yield* TestClock.adjust("1 hour");
				yield* root.waitForIdle;
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle", "fenced"]);
				expect(yield* scripted.callCount).toBe(1);
				expect(yield* scripted.pendingResponseCount).toBe(1);

				// The transcript up to the refused request is intact, and the refusal is its last entry.
				const stopped = yield* transcript(root);
				expect(stopped).toEqual([
					"pi.user",
					"pi.system",
					"pi.assistant:toolUse",
					"pi.tool-result",
					"pi.assistant:error",
				]);

				// A new lease: the same run goes on from the tool result and answers.
				lease.fenced = undefined;
				const continued = yield* continueStopped(root);
				expect(yield* stopOf(root.id)).toEqual(Option.none());
				expect(yield* continued.wait).toMatchObject({ status: "done" });
				expect(yield* transcript(root)).toEqual([...stopped, "pi.assistant:stop"]);
				expect(yield* scripted.callCount).toBe(2);
				expect(lease.steps.map(({ step }) => step)).toEqual(["reserve", "settle", "fenced", "reserve", "settle"]);
				expect(yield* stopOf(root.id)).toEqual(Option.none());
			}).pipe(Effect.provide(harness())),
		));

	it("stops a run whose first request is refused, and reads no stop from another failure", () =>
		run(
			Effect.gen(function* () {
				const scripted = yield* ScriptedModels;
				const lease = yield* TestLease;
				lease.fenced = "out_of_money";
				const root = yield* rootConversation;
				const refused = yield* root.prompt("Hello");
				expect(refused).toMatchObject({ status: "unanswered", reason: "model_error" });
				expect(Option.getOrThrow(yield* stopOf(root.id)).refusal).toMatchObject({
					_tag: "LeaseFenced",
					reason: "out_of_money",
				});
				expect(yield* scripted.callCount).toBe(0);

				// The provider fails the continued run with an error of its own: a failure, but not a stop of the budget.
				lease.fenced = undefined;
				yield* scripted.setResponses([failure("boom")]);
				const failed = yield* Effect.flatMap(continueStopped(root), (submission) => submission.wait);
				expect(failed).toMatchObject({ status: "unanswered", reason: "model_error", detail: "boom" });
				expect(yield* stopOf(root.id)).toEqual(Option.none());
				expect(yield* refusalOf(failed.detail)).toEqual(Option.none());
			}),
		));
});

/** A response the provider fails with `text`, which pi-ai does not call retryable. */
function failure(text: string) {
	return { ...answer(""), stopReason: "error" as const, errorMessage: text };
}
