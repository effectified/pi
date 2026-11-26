// A thread from task to outcome on the whole composition: what is recorded, reserved, settled and routed, and how a
// cancel and a failing model end it.

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { answer, held, toolCall } from "@effectified/pi-durable/testing";
import { Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadNotFound, Threads } from "../src/index.ts";
import {
	advisory,
	committed,
	conflicts,
	ESTIMATE,
	expectedCost,
	JUDGE,
	outside,
	providers,
	reservations,
	routed,
	run,
	shape,
	WRITER,
	work,
} from "./world.ts";

describe("a thread that calls a granted tool and answers", () => {
	const play = async () => {
		const state = outside();
		const labs = providers({
			author: [toolCall("lookup", { id: "42" }, { id: "call-1" }), answer("Record 42 is titled Answer.")],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const outcome = yield* threads.work(work("t1", "What is record 42 called?"));
				const conversation = yield* threads.conversation("t1");
				return {
					outcome,
					conversation: conversation.id,
					events: [...(yield* routed(state, 3))],
					again: yield* threads.work(work("t1", "What is record 42 called?")),
					stored: yield* threads.outcome("t1"),
					probe: yield* threads.probe("t1"),
				};
			}),
		);
		return { state, labs, ...result };
	};

	it("ends reviewed, with its turns, its tool call and the money the budget settled", async () => {
		const { state, outcome, again, stored, probe } = await play();
		const settled = reservations(state).reduce((sum, { settlements }) => sum + (settlements[0]?.cost ?? 0n), 0n);
		expect(outcome).toMatchObject({
			_tag: "Reviewed",
			accepted: false,
			counts: { turns: 2, toolCalls: 1, refusedToolCalls: 0, settledMicros: settled },
			verdict: {
				pass: 1,
				corrections: 0,
				author: { ...WRITER, family: "alpha" },
				// Both name the route that served, not the alias that was asked.
				reviewer: { ...JUDGE, family: "beta" },
				call: { provider: JUDGE.provider, model: JUDGE.modelId, stopReason: "stop" },
				findings: [],
				failures: [],
				outcome: { _tag: "Passed" },
			},
		});
		expect(settled > 0n).toBe(true);
		// The outcome is read from storage: a second call for the same thread, and a plain read, say the same.
		expect(again).toEqual(outcome);
		expect(stored).toEqual(Option.some(outcome));
		expect(probe).toEqual({ alive: false });
		expect(state.ran).toEqual({ lookup: 1 });
	});

	it("leaves exactly its records in the sink, each id once, in entry order", async () => {
		const { state, conversation } = await play();
		expect(committed(state).map(shape)).toEqual([
			{ _tag: "Message", role: "user", entryKind: "pi.user", text: "What is record 42 called?" },
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "toolUse", error: null },
			{ _tag: "ToolCallRequested", name: "lookup", callId: "call-1", arguments: { id: "42" } },
			{
				_tag: "ToolCallResult",
				name: "lookup",
				callId: "call-1",
				isError: false,
				codes: [],
				text: "Record 42 is titled Answer.",
			},
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "stop", error: null },
			{ _tag: "Message", role: "assistant", entryKind: "pi.assistant", text: "Record 42 is titled Answer." },
			// The verdict, with the reviewer's request in it, and right after it that request as a model call of its
			// own: test/review.test.ts asserts both records whole.
			{ _tag: "Entry", kind: "review.verdict" },
			{ _tag: "ModelCall", provider: "reviewer-lab", model: "judge", stopReason: "stop", error: null },
		]);
		// One advisory record per request of the conversation. The reviewer's request is its task's own, not a
		// generation's: no hook is asked before it, so it has a record once its verdict is stored and none before.
		expect(advisory(state).map((record) => [record.conversation, record.advisory])).toEqual([
			[conversation, true],
			[conversation, true],
		]);
		// Ids are `<conversation>:<entry>:<message>:<part>`, and `<conversation>:<entry>:entry` for an entry without a
		// message: one conversation, entries ascending, each id once. The reviewer's call has the id a model call of
		// the verdict's entry would have, which no record of the recorder has: that entry holds no message.
		const ids = committed(state).map((record) => record.id.split(":"));
		expect(ids.map(([in_, , message, ...part]) => [Number(in_), message, part.join(":")])).toEqual([
			[conversation, "0", "message"],
			[conversation, "0", "model"],
			[conversation, "0", "call:0"],
			[conversation, "0", "result"],
			[conversation, "0", "model"],
			[conversation, "0", "message"],
			[conversation, "entry", ""],
			[conversation, "0", "model"],
		]);
		const entries = ids.map(([, entry]) => Number(entry));
		expect(entries).toEqual([...entries].sort((a, b) => a - b));
		expect(new Set(entries).size).toBe(5);
		const delivered = state.delivered.flat().map((record) => record.id);
		expect(new Set(delivered).size).toBe(delivered.length);
		expect(conflicts(state)).toEqual([]);
	});

	it("reserves and settles once per provider request, at the exact cost of the price table", async () => {
		const { state, labs, conversation } = await play();
		expect([labs.author.state.callCount, labs.backup.state.callCount, labs.reviewer.state.callCount]).toEqual([
			2, 0, 1,
		]);
		const reserved = reservations(state);
		expect(state.lease.steps.map((step) => step.step)).toEqual([
			"reserve",
			"settle",
			"reserve",
			"settle",
			"reserve",
			"settle",
		]);
		expect(
			reserved.map(({ estimate, request }) => [estimate, request.kind, request.provider, request.model]),
		).toEqual([
			[ESTIMATE, "chat", "router", "author"],
			[ESTIMATE, "chat", "router", "author"],
			[ESTIMATE, "chat", "router", "reviewer"],
		]);
		// The reviewer's request carries the thread's provider session: it counts against the thread's share.
		expect(reserved.map(({ request }) => request.conversation)).toEqual([conversation, conversation, conversation]);
		expect(new Set(reserved.map(({ request }) => request.session)).size).toBe(1);
		expect(reserved.map(({ settlements }) => settlements.length)).toEqual([1, 1, 1]);
		// Every request settles what its recorded response used, at the price of the route that served: the author's
		// two, and the reviewer's, whose record is made of its verdict.
		const calls = committed(state).flatMap((record) => (record._tag === "ModelCall" ? [record] : []));
		expect(calls.map((call) => ({ provider: call.provider, modelId: call.model }))).toEqual([WRITER, WRITER, JUDGE]);
		expect(reserved.map(({ settlements }) => settlements[0])).toEqual(
			calls.map(({ provider, model, usage: { input, output, cacheRead, cacheWrite } }) => ({
				usage: { input, output, cacheRead, cacheWrite },
				cost: expectedCost({ provider, modelId: model }, { input, output, cacheRead, cacheWrite }),
				outcome: "returned",
			})),
		);
		const review = reserved[2]?.settlements[0];
		expect(review).toMatchObject({ outcome: "returned" });
		expect(review?.cost).toBe(
			expectedCost(JUDGE, review?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);
		expect(reserved.every(({ settlements }) => (settlements[0]?.cost ?? 0n) > 0n)).toBe(true);
	});

	it("names the routes that served in the route events, at the cost the lease was told", async () => {
		const { state, events } = await play();
		expect(
			events.map(({ alias, route, attempt, outcome, fallback }) => [
				alias,
				route.provider,
				route.model,
				attempt,
				outcome,
				fallback,
			]),
		).toEqual([
			["author", "author-lab", "writer", 1, "served", false],
			["author", "author-lab", "writer", 1, "served", false],
			["reviewer", "reviewer-lab", "judge", 1, "served", false],
		]);
		expect(events.map((event) => event.cost.micros)).toEqual(
			reservations(state).map(({ settlements }) => settlements[0]?.cost),
		);
	});
});

describe("a thread that does not reach an answer", () => {
	it("is cancelled in the middle of a model request, and stays cancelled", async () => {
		const state = outside();
		const turn = held(answer("Never said."));
		const labs = providers({ author: [turn.response] });
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const working = yield* Effect.forkScoped(threads.work(work("t1", "Say hi.")));
				yield* turn.requested;
				const during = yield* threads.probe("t1");
				yield* threads.cancel("t1");
				const outcome = yield* Fiber.join(working);
				// A second cancel, and a resume, change nothing: a cancelled thread is not continued.
				yield* threads.cancel("t1");
				return { during, outcome, resumed: yield* threads.resume("t1"), after: yield* threads.probe("t1") };
			}),
		);
		const cancelled = {
			_tag: "Cancelled",
			counts: { turns: 0, toolCalls: 0, refusedToolCalls: 0, settledMicros: 0n },
		};
		expect(result).toEqual({
			during: { alive: true },
			outcome: cancelled,
			resumed: cancelled,
			after: { alive: false },
		});
		// The request was sent once and aborted; its reservation is settled, with what the provider had used: nothing.
		expect(labs.author.state.callCount).toBe(1);
		expect(reservations(state).map(({ settlements }) => settlements)).toEqual([
			[{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0n, outcome: "aborted" }],
		]);
		// Pi commits no entry for a request an abort stopped before its first partial: the sink has the input only.
		expect(committed(state).map(shape)).toEqual([
			{ _tag: "Message", role: "user", entryKind: "pi.user", text: "Say hi." },
		]);
		expect(advisory(state)).toHaveLength(1);
	});

	it("ends errored when the model fails, and the failed request is settled and recorded", async () => {
		const state = outside();
		const labs = providers({
			author: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" })],
		});
		const outcome = await run(
			state,
			labs,
			Threads.Threads.use((threads) => threads.work(work("t1", "Say hi."))),
		);
		const [failed] = reservations(state).map(({ settlements }) => settlements[0]);
		expect(reservations(state)).toHaveLength(1);
		expect(failed).toMatchObject({ outcome: "failed" });
		expect(failed?.cost).toBe(
			expectedCost(WRITER, failed?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);
		expect((failed?.cost ?? 0n) > 0n).toBe(true);
		expect(outcome).toEqual({
			_tag: "Errored",
			reason: "model_error",
			detail: "invalid request",
			counts: { turns: 0, toolCalls: 0, refusedToolCalls: 0, settledMicros: failed?.cost },
		});
		// An error that is not retryable ends the request on its route: the next route is not tried.
		expect([labs.author.state.callCount, labs.backup.state.callCount]).toEqual([1, 0]);
		expect(committed(state).map(shape)).toEqual([
			{ _tag: "Message", role: "user", entryKind: "pi.user", text: "Say hi." },
			{ _tag: "ModelCall", provider: "author-lab", model: "writer", stopReason: "error", error: "invalid request" },
		]);
	});

	it("counts no turn for a response Pi stored as a failed attempt: a deferred one without a handle", async () => {
		const state = outside();
		const labs = providers({ author: [fauxAssistantMessage("", { stopReason: "deferred" })] });
		const outcome = await run(
			state,
			labs,
			Threads.Threads.use((threads) => threads.work(work("t1", "Say hi."))),
		);
		expect(outcome).toMatchObject({ counts: { turns: 0, toolCalls: 0 } });
		// Pi stored the response: it is an attempt, and no turn.
		expect(committed(state).map(shape)).toContainEqual(expect.objectContaining({ stopReason: "deferred" }));
	});

	it("is continued by a resume after an error, on the transcript as it is", async () => {
		const state = outside();
		const labs = providers({
			author: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" }), answer("Hi.")],
			reviewer: [answer('{"findings":[]}')],
		});
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const errored = yield* threads.work(work("t1", "Say hi."));
				return { errored: errored._tag, resumed: yield* threads.resume("t1"), again: yield* threads.resume("t1") };
			}),
		);
		expect(result.errored).toBe("Errored");
		expect(result.resumed).toMatchObject({ _tag: "Reviewed", counts: { turns: 1 } });
		// A thread that ended with an answer is not continued: the second resume sends nothing.
		expect(result.again).toEqual(result.resumed);
		expect([labs.author.state.callCount, labs.reviewer.state.callCount]).toEqual([2, 1]);
	});

	it("refuses a thread of fewer than 1 turn before anything of it is created", async () => {
		const state = outside();
		const labs = providers();
		const result = await run(
			state,
			labs,
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const refused = yield* Effect.flip(threads.admit({ ...work("t1", "Say hi."), maxTurns: 0 }));
				return { refused: refused._tag, probe: yield* threads.probe("t1") };
			}),
		);
		expect(result).toEqual({ refused: "SchemaDecodeError", probe: { alive: false } });
		expect(labs.author.state.callCount).toBe(0);
	});

	it("is not found by a key nothing was started under", async () => {
		const state = outside();
		const result = await run(
			state,
			providers(),
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				return {
					probe: yield* threads.probe("nobody"),
					resume: yield* Effect.flip(threads.resume("nobody")),
					cancel: yield* Effect.flip(threads.cancel("nobody")),
				};
			}),
		);
		expect(result.probe).toEqual({ alive: false });
		expect(result.resume).toEqual(new ThreadNotFound({ thread: "nobody" }));
		expect(result.cancel).toEqual(new ThreadNotFound({ thread: "nobody" }));
	});
});
