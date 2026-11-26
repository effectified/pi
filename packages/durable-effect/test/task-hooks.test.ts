import type { Report } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { Extension, Harness, Task, TaskHooks } from "../src/index.ts";
import { TestHarness } from "../src/testing/index.ts";

class Refused extends Schema.TaggedError<Refused>()("Refused", { why: Schema.String }) {}

/** What the strict checker reads its verdict from: a service, so a test sees the answer ran with it. */
class Strictness extends Context.Service<Strictness, { readonly limit: number }>()("test/Strictness") {}

/** The hooks a review task asks: `check` gives a verdict on a text. */
const ReviewHooks = TaskHooks.make<{ readonly check: (text: string) => Effect.Effect<string, Refused> }>({
	name: "test.review",
});

/** A task that asks every `check` answer about its text and completes with their verdicts, in the order asked. */
const Review = Task.make({
	name: "test.review",
	version: 1,
	input: Schema.Struct({ text: Schema.String }),
	state: Schema.Struct({ phase: Schema.Literal("ask") }),
	result: Schema.Array(Schema.String),
	initial: () => ({ phase: "ask" as const }),
	phases: {
		ask: (task, api) =>
			Effect.gen(function* () {
				const verdicts: string[] = [];
				yield* api.eachHook(ReviewHooks, "check", (check) =>
					Effect.map(check(task.input.text), (verdict) => void verdicts.push(verdict)),
				);
				return Task.complete(verdicts);
			}),
	},
	abort: () => Effect.succeed(Task.aborted()),
});

const strict = Extension.make({
	name: "strict",
	hooks: [
		TaskHooks.answer(ReviewHooks, {
			check: (text) => Strictness.use(({ limit }) => Effect.succeed(text.length <= limit ? "short" : "long")),
		}),
	],
});

const broken = Extension.make({
	name: "broken",
	hooks: [TaskHooks.answer(ReviewHooks, { check: () => Effect.fail(new Refused({ why: "no opinion" })) })],
});

const kind = Extension.make({
	name: "kind",
	hooks: [TaskHooks.answer(ReviewHooks, { check: () => Effect.succeed("fine") })],
});

describe("TaskHooks", () => {
	it("asks the answers of the selected extensions in extension order, with the registry's services", async () => {
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const reports: Report[] = [];
				yield* Effect.forkChild(
					Stream.runForEach(Harness.reports, (report) => Effect.sync(() => reports.push(report))),
					{ startImmediately: true },
				);
				const root = yield* TestHarness.root;
				const id = yield* root.commit((tx) =>
					tx.createTask(Review, { text: "Hello." }, { ownership: { kind: "conversation" } }),
				);
				const settled = yield* Harness.waitForTaskOf(Review, id);
				return { outcome: settled.state.outcome, reports: reports.map((report) => report.kind) };
			}).pipe(
				Effect.provide(
					TestHarness.layer({
						extensions: [Extension.make({ name: "app", tasks: [Review] }), strict, broken, kind],
					}),
				),
				Effect.provide(Layer.succeed(Strictness, { limit: 3 })),
				Effect.scoped,
			),
		);
		// The failing answer is reported and skipped: a hook fails open.
		expect(seen).toEqual({
			outcome: { status: "completed", result: ["long", "fine"] },
			reports: ["extension_error"],
		});
	});

	it("makes the registry require what the answers need", () => {
		const services: Equal<Extension.Services<typeof strict>, Strictness> = true;
		expect(services).toBe(true);
	});
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
