// The interruption suite (PRD section 10): the fiber that runs `Conversation.prompt` is interrupted at each point
// where it waits, in a scripted run of an input, a model turn that calls the tool `write`, the tool, and a model turn
// that answers. The points, in run order:
//
//   admission, before its first read   Pi has the input but has read and written nothing
//   admission, in its commit           the commit that stores the input is in flight
//   the first model request            the input is admitted and the model was asked
//   the tool handler                   the handler runs
//   the second model request           the tool's result is committed and the model was asked again
//
// At each of them the interruption ends the caller's fiber and nothing else: Pi admits an input it was handed, and
// a wait is only a wait (Pi Durable README: `Submission.wait`, "cancelling `context` cancels only this wait"). To stop
// the run itself, call `Conversation.abort`.

import { MemoryStorage } from "@earendil-works/pi-durable";
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { type Conversation, Extension, Harness, Storage, Tool } from "../src/index.ts";
import { answer, held, ScriptedModels, TestHarness, toolCall } from "../src/testing/index.ts";

/** A memory storage that holds one call of `submissionByRequest` or `commit` until it is released. */
class HeldStorage extends MemoryStorage {
	holding: "submissionByRequest" | "commit" | undefined;
	readonly reached = Promise.withResolvers<void>();
	readonly released = Promise.withResolvers<void>();

	override async submissionByRequest(...args: Parameters<MemoryStorage["submissionByRequest"]>) {
		await this.#hold("submissionByRequest");
		return super.submissionByRequest(...args);
	}

	override async commit(...args: Parameters<MemoryStorage["commit"]>) {
		await this.#hold("commit");
		return super.commit(...args);
	}

	async #hold(call: "submissionByRequest" | "commit"): Promise<void> {
		if (this.holding !== call) return;
		this.holding = undefined;
		this.reached.resolve();
		await this.released.promise;
	}
}

/** The scripted run: both model turns and the tool handler can be held, and released. */
function scene() {
	const storage = new HeldStorage();
	const first = held(toolCall("write", { text: "hi" }, { id: "call-1" }));
	const second = held(answer("Written."));
	const tool = {
		started: Promise.withResolvers<void>(),
		released: Promise.withResolvers<void>(),
		runs: 0,
		interrupted: false,
	};
	const Write = Tool.make("write", {
		description: "Write a text.",
		parameters: Schema.Struct({ text: Schema.String }),
		success: Schema.String,
		handler: ({ text }) =>
			Effect.sync(() => {
				tool.runs += 1;
				tool.started.resolve();
			}).pipe(
				Effect.andThen(Effect.promise(() => tool.released.promise)),
				Effect.as(`wrote ${text}`),
				Effect.onInterrupt(() =>
					Effect.sync(() => {
						tool.interrupted = true;
					}),
				),
			),
	});
	const layer = TestHarness.layer({
		extensions: [Extension.make({ name: "app", tools: [Write] })],
		responses: [first.response, second.response, answer("Again.")],
		storage: Storage.custom(storage),
	});
	const releaseTool = Effect.sync(() => tool.released.resolve());
	return { storage, first, second, tool, releaseTool, layer };
}

type Scene = ReturnType<typeof scene>;

const INPUT = { type: "input", content: "Write hi.", requestId: "first" } as const;

const kinds = (conversation: Conversation.Conversation) =>
	Effect.map(Stream.runCollect(conversation.entries({ order: "ascending" })), (entries) =>
		entries.map((entry) => [
			entry.kind,
			entry.model?.[0]?.role === "assistant" ? entry.model[0].stopReason : undefined,
		]),
	);

/**
 * Forks `prompt`, interrupts it once `reached` succeeded, and reports how the fiber ended and what the harness
 * showed right after. `release` runs while the interruption is pending, for a point that holds the call itself.
 */
const interruptAt = (reached: Effect.Effect<void>, release: Effect.Effect<void> = Effect.void) =>
	Effect.gen(function* () {
		const root = yield* TestHarness.root;
		const prompting = yield* Effect.forkChild(root.prompt(INPUT.content, { requestId: INPUT.requestId }));
		yield* reached;
		// Synchronous, so the interruption has reached Pi's call before anything is released.
		prompting.interruptUnsafe();
		yield* release;
		const exit = yield* Fiber.await(prompting);
		const inspection = yield* Harness.inspect;
		return {
			interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
			live: inspection.tasks.map((task) => [task.record.kind, task.state.kind]),
			submissions: inspection.submissions.map((submission) => [submission.requestId, submission.status]),
		};
	});

/**
 * Once the conversation is idle: how the interrupted prompt's input settled (the same request id finds it), the
 * transcript, and the transcript after one more prompt.
 */
const aftermath = Effect.gen(function* () {
	const root = yield* TestHarness.root;
	yield* root.waitForIdle;
	const first = yield* (yield* root.submit(INPUT)).status;
	const transcript = yield* kinds(root);
	const again = yield* root.prompt("Again.", { requestId: "second" });
	yield* root.waitForIdle;
	const idle = yield* Harness.inspect;
	return {
		first: [first.requestId, first.status],
		transcript,
		again: [again.requestId, again.status],
		after: yield* kinds(root),
		idle: [idle.tasks.length, idle.submissions.length],
		requests: yield* ScriptedModels.use((models) => models.callCount),
	};
});

/** Every point leaves this: the first run whole, then the second prompt's turn, and nothing live. */
const CONSISTENT = {
	first: ["first", "done"],
	transcript: [
		["pi.user", undefined],
		["pi.system", undefined],
		["pi.assistant", "toolUse"],
		["pi.tool-result", undefined],
		["pi.assistant", "stop"],
	],
	again: ["second", "done"],
	after: [
		["pi.user", undefined],
		["pi.system", undefined],
		["pi.assistant", "toolUse"],
		["pi.tool-result", undefined],
		["pi.assistant", "stop"],
		["pi.user", undefined],
		["pi.assistant", "stop"],
	],
	idle: [0, 0],
	requests: 3,
};

const releaseAll = (of: Scene) => Effect.all([of.first.release, of.releaseTool, of.second.release], { discard: true });

describe("interrupting prompt", () => {
	for (const call of ["submissionByRequest", "commit"] as const) {
		const point = call === "commit" ? "in its commit" : "before its first read";
		it(`during admission, ${point}: the fiber ends once Pi admitted the input, and the run answers it`, async () => {
			const of = scene();
			const seen = await Effect.runPromise(
				Effect.gen(function* () {
					yield* TestHarness.root;
					yield* releaseAll(of);
					of.storage.holding = call;
					const cut = yield* interruptAt(
						Effect.promise(() => of.storage.reached.promise),
						Effect.sync(() => of.storage.released.resolve()),
					);
					return { cut, after: yield* aftermath };
				}).pipe(Effect.provide(of.layer)),
			);
			expect(seen.cut.interrupted).toBe(true);
			expect(seen.after).toEqual(CONSISTENT);
			expect([of.tool.runs, of.tool.interrupted]).toEqual([1, false]);
		});
	}

	it("during the first model request: the request stays in flight, and the run goes on when the model answers", async () => {
		const of = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				const cut = yield* interruptAt(of.first.requested);
				const requests = yield* ScriptedModels.use((models) => models.callCount);
				yield* releaseAll(of);
				return { cut, requests, after: yield* aftermath };
			}).pipe(Effect.provide(of.layer)),
		);
		expect(seen.cut).toEqual({
			interrupted: true,
			live: [["pi.generation", "running"]],
			submissions: [["first", "placed"]],
		});
		expect(seen.requests).toBe(1);
		expect(seen.after).toEqual(CONSISTENT);
		expect([of.tool.runs, of.tool.interrupted]).toEqual([1, false]);
	});

	it("during the tool handler: the handler is not interrupted and runs once", async () => {
		const of = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* of.first.release;
				const cut = yield* interruptAt(Effect.promise(() => of.tool.started.promise));
				const running = [of.tool.runs, of.tool.interrupted];
				yield* releaseAll(of);
				return { cut, running, after: yield* aftermath };
			}).pipe(Effect.provide(of.layer)),
		);
		expect(seen.cut).toEqual({
			interrupted: true,
			live: [
				["pi.generation", "waiting"],
				["pi.tool", "running"],
			],
			submissions: [["first", "placed"]],
		});
		expect(seen.running).toEqual([1, false]);
		expect(seen.after).toEqual(CONSISTENT);
		expect([of.tool.runs, of.tool.interrupted]).toEqual([1, false]);
	});

	it("during the second model request: the tool's result stays, and the run goes on when the model answers", async () => {
		const of = scene();
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.all([of.first.release, of.releaseTool], { discard: true });
				const cut = yield* interruptAt(of.second.requested);
				const root = yield* TestHarness.root;
				const transcript = yield* kinds(root);
				yield* of.second.release;
				return { cut, transcript, after: yield* aftermath };
			}).pipe(Effect.provide(of.layer)),
		);
		expect(seen.cut).toEqual({
			interrupted: true,
			live: [["pi.generation", "running"]],
			submissions: [["first", "placed"]],
		});
		// No half-written turn while the model is still asked: the entries end with the committed tool result.
		expect(seen.transcript).toEqual(CONSISTENT.transcript.slice(0, 4));
		expect(seen.after).toEqual(CONSISTENT);
		expect([of.tool.runs, of.tool.interrupted]).toEqual([1, false]);
	});
});
